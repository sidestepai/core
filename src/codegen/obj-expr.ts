/**
 * Item 4 — the inverse of `obj()`, for `const:expr2` / `const:expr` values.
 *
 * A dynamic object is stored as ONE value whose `value` is the object rendered
 * as a XanoScript expression string (`{ question: $input.question }`). There is
 * no structured form to walk, so decoding it means parsing that string — which
 * is why the original plan scoped U3 to trivially-invertible shapes and left
 * this one emitting an annotated `rawValue({…})` literal. Exact, but it reads as
 * data.
 *
 * This parser is deliberately **narrow**: it accepts exactly the grammar
 * `src/values/obj.ts` emits, and nothing else. That is the whole reason it is
 * safe. A general XanoScript expression language (arithmetic, comparisons, function
 * calls) is a much larger surface where a subtly wrong parse would produce a
 * plausible but different value — so anything outside the grammar returns
 * `null` and the caller falls back exactly as before.
 *
 * Safety does not rest on the parser being right, though. The caller re-runs the
 * real `obj()` over whatever this returns and compares the re-rendered string to
 * the stored one, emitting only on an exact match (the standing proof-carrying
 * rule). A parser bug therefore costs readability, never fidelity.
 */
import { auth, c, col, inp, ref, type Value } from "../values/value.js";
import type { ObjInput, ObjMember } from "../values/obj.js";
import { call, lit, obj as objExpr, arr, type Expr } from "./print.js";

/** A parsed member: what to print, and what to feed the real `obj()` to prove it. */
interface Parsed {
  readonly expr: Expr;
  readonly built: ObjMember;
  /** Authoring symbols the emitted expression needs imported. */
  readonly symbols: readonly string[];
}

/** Bare-identifier keys — the only kind XanoScript object literals accept. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A `$`-rooted reference path, e.g. `$input.user.id`. */
const REFERENCE = /^\$(input|var|auth|db)((?:\.[A-Za-z0-9_$]+)*)$/;

/** A hand-rolled cursor — the grammar is small enough not to warrant a lexer. */
class Cursor {
  #text: string;
  #at = 0;

  constructor(text: string) {
    this.#text = text;
  }

  get done(): boolean {
    return this.#at >= this.#text.length;
  }

  skipSpace(): void {
    while (this.#at < this.#text.length && /\s/.test(this.#text[this.#at]!)) this.#at++;
  }

  /** Consume `token` if it is next, after whitespace. */
  eat(token: string): boolean {
    this.skipSpace();
    if (!this.#text.startsWith(token, this.#at)) return false;
    this.#at += token.length;
    return true;
  }

  peek(): string | undefined {
    this.skipSpace();
    return this.#text[this.#at];
  }

  /** Consume while `re` matches, returning the run (possibly empty). */
  take(re: RegExp): string {
    this.skipSpace();
    const start = this.#at;
    while (this.#at < this.#text.length && re.test(this.#text[this.#at]!)) this.#at++;
    return this.#text.slice(start, this.#at);
  }

  /**
   * Consume a JSON double-quoted string, honouring escapes. Returns null when
   * the next token is not a well-formed string.
   */
  takeString(): string | null {
    this.skipSpace();
    if (this.#text[this.#at] !== '"') return null;
    let i = this.#at + 1;
    let out = "";
    while (i < this.#text.length) {
      const ch = this.#text[i]!;
      if (ch === "\\") {
        const next = this.#text[i + 1];
        if (next === undefined) return null;
        // Delegate escape semantics to JSON.parse rather than reimplementing
        // them — `\uXXXX` in particular is easy to get subtly wrong.
        const decoded = tryJsonParse(`"\\${next}"`);
        if (next === "u") {
          const seq = this.#text.slice(i, i + 6);
          const hex = tryJsonParse(`"${seq}"`);
          if (typeof hex !== "string") return null;
          out += hex;
          i += 6;
          continue;
        }
        if (typeof decoded !== "string") return null;
        out += decoded;
        i += 2;
        continue;
      }
      if (ch === '"') {
        this.#at = i + 1;
        return out;
      }
      out += ch;
      i++;
    }
    return null;
  }
}

function tryJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `$input.a.b` → the matching authoring call, or null if not a reference. */
function parseReference(token: string): Parsed | null {
  const m = REFERENCE.exec(token);
  if (!m) return null;
  const root = m[1]!;
  const path = m[2]!.replace(/^\./, "");

  switch (root) {
    case "input":
      return path === "" ? null : { expr: call("inp", lit(path)), built: inp(path), symbols: ["inp"] };
    case "var":
      return path === "" ? null : { expr: call("ref", lit(path)), built: ref(path), symbols: ["ref"] };
    case "db":
      return path === "" ? null : { expr: call("col", lit(path)), built: col(path), symbols: ["col"] };
    case "auth":
      // `$auth` alone is the whole auth record; `$auth.x` is one field. Both are
      // reachable, unlike the others, whose bare form `obj()` never emits.
      return path === ""
        ? { expr: call("auth"), built: auth(), symbols: ["auth"] }
        : { expr: call("auth", lit(path)), built: auth(path), symbols: ["auth"] };
    default:
      return null;
  }
}

/** One member: reference, scalar literal, nested record, or array. */
function parseMember(cur: Cursor): Parsed | null {
  const next = cur.peek();
  if (next === undefined) return null;

  if (next === "{") return parseRecord(cur);

  if (next === "[") {
    if (!cur.eat("[")) return null;
    const exprs: Expr[] = [];
    const built: ObjMember[] = [];
    const symbols: string[] = [];
    if (cur.eat("]")) return { expr: arr([]), built: [], symbols: [] };
    for (;;) {
      const member = parseMember(cur);
      if (!member) return null;
      exprs.push(member.expr);
      built.push(member.built);
      symbols.push(...member.symbols);
      if (cur.eat(",")) continue;
      if (cur.eat("]")) break;
      return null;
    }
    return { expr: arr(exprs), built, symbols };
  }

  if (next === '"') {
    const text = cur.takeString();
    // A raw string member, which is what `obj()` renders a bare string to. Kept
    // as a raw literal rather than `c.text(...)`: both encode identically and
    // `{ greeting: "hi" }` is the more readable of the two.
    return text === null ? null : { expr: lit(text), built: text, symbols: [] };
  }

  // A bare token: `$`-reference, number, true/false, or null.
  const token = cur.take(/[A-Za-z0-9_$.\-+]/);
  if (token === "") return null;

  const reference = parseReference(token);
  if (reference) return reference;

  if (token === "true" || token === "false") {
    const value = token === "true";
    return { expr: lit(value), built: value, symbols: [] };
  }
  // `null` has no raw ObjMember form — `obj()` reaches it only via `c.null()`.
  if (token === "null") return { expr: call("c.null"), built: c.null(), symbols: ["c"] };

  if (/^-?\d+(\.\d+)?$/.test(token)) {
    const n = Number(token);
    // Reject anything that would not render back identically (e.g. `1.50`,
    // `+3`), rather than relying on the caller's proof to catch it.
    return Number.isFinite(n) && String(n) === token
      ? { expr: lit(n), built: n, symbols: [] }
      : null;
  }
  return null;
}

/** `{ key: member, … }` — the only top-level form `obj()` emits. */
function parseRecord(cur: Cursor): Parsed | null {
  if (!cur.eat("{")) return null;
  const entries: Array<readonly [string, Expr]> = [];
  const built: ObjInput = {};
  const symbols: string[] = [];

  if (cur.eat("}")) return { expr: objExpr([]), built, symbols };

  for (;;) {
    const key = cur.take(/[A-Za-z0-9_$]/);
    if (key === "" || !IDENT.test(key)) return null;
    if (!cur.eat(":")) return null;
    const member = parseMember(cur);
    if (!member) return null;
    // A duplicate key would silently drop one member on the way back.
    if (Object.hasOwn(built, key)) return null;
    entries.push([key, member.expr]);
    built[key] = member.built;
    symbols.push(...member.symbols);
    if (cur.eat(",")) continue;
    if (cur.eat("}")) break;
    return null;
  }
  return { expr: objExpr(entries), built, symbols };
}

/** What a successful parse hands back to the value decoder. */
export interface ObjExprCandidate {
  /** The `obj({…})` call to print. */
  readonly expr: Expr;
  /** The record to re-run through the real `obj()` as proof. */
  readonly built: ObjInput;
  /** Authoring symbols the printed expression needs, including `obj` itself. */
  readonly symbols: readonly string[];
}

/**
 * Parse a stored dynamic-object expression string into an `obj({…})` call.
 *
 * Returns null for anything outside the grammar `obj()` emits — the caller then
 * falls back to `rawValue`, exactly as before. Never throws.
 */
export function parseObjExpr(value: string): ObjExprCandidate | null {
  const cur = new Cursor(value);
  if (cur.peek() !== "{") return null;
  const parsed = parseRecord(cur);
  if (!parsed) return null;
  cur.skipSpace();
  // Trailing content means the string was more than one object literal, so the
  // parse does not account for the whole value.
  if (!cur.done) return null;
  return {
    expr: call("obj", parsed.expr),
    built: parsed.built as ObjInput,
    symbols: ["obj", ...parsed.symbols],
  };
}

/** Re-export so the value decoder builds through the same constructor it proves against. */
export type { Value };
