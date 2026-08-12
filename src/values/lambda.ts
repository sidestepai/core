/**
 * `lam.*` — write a lambda body as a real, typed TypeScript function instead of
 * an opaque string (issue #221).
 *
 * Every JavaScript surface in Xano takes its body as text: the lambda statement's
 * `code` field, and the code argument of `fl.map` / `filter` / `some` / `every` /
 * `find` / `findIndex` / `reduce` / `lambda`. That text runs against a small,
 * closed set of injected identifiers — and which ones are in scope depends on
 * WHICH surface it is. #221 is what that costs: an author reached for `$acc` as
 * the reduce accumulator, the real name is `$result`, and the first signal was a
 * wrong value at runtime, because a body that throws comes back as its own
 * diagnostic text in the value slot with HTTP 200.
 *
 * So the binding set is the type here. The author writes an arrow function whose
 * first parameter destructures the bindings; the editor supplies them, `$acc` is
 * a compile error, and {@link lam.fn} extracts the body text at author time. What
 * reaches the wire is the same `const:text` a hand-written `c.text(...)` produced
 * — this is purely an authoring layer, with no encoder, normalizer, or codegen
 * change behind it.
 *
 * The build-time guard is a whitelist, and it is sound rather than heuristic: a
 * stack variable is NOT injected as a bare `$name` identifier (it is reached as
 * `$var.name`), so any `$identifier` outside {@link LAMBDA_BINDINGS} for that
 * surface is provably undefined at runtime. Live-probed and recorded in
 * `vendor/lambda-bindings.json`; `test/values/lambda.test.ts` fails if this table
 * and that record drift apart.
 *
 * ```ts
 * withFilters(ref("prices"), fl.reduce({ initial: 0, code: lam.fn(({ $result, $this }) => $result + $this) }))
 * s.lambda({ as: "total", code: lam.fn(({ $var }) => $var.subtotal * 1.2) })
 * ```
 */
import { c } from "./value.js";
import type { Value } from "./value.js";

/** A surface that takes a JavaScript body: the lambda statement, or a filter. */
export type LambdaSurface =
  | "s.lambda"
  | "fl.lambda"
  | "map"
  | "filter"
  | "some"
  | "every"
  | "find"
  | "findIndex"
  | "reduce";

/**
 * Surface → the identifiers a body may reference. Live-probed
 * (`scripts/probe-lambda-bindings.ts`) rather than read off any documentation,
 * and asserted against the recorded probe output in the tests, so the guard, the
 * types, and the docs cannot disagree with the engine or with each other.
 *
 * `console` and `crypto` are globals inside the body rather than destructured
 * bindings, so they are legal to reference but are not part of the parameter
 * type. Every other entry is `$`-prefixed, which is what makes the scan below
 * able to see a violation at all.
 */
export const LAMBDA_BINDINGS: Readonly<Record<LambdaSurface, readonly string[]>> = {
  // Runs once, over no element and no piped value.
  "s.lambda": ["$env", "$input", "$var", "$auth"],
  // Runs once, over the piped value — which it binds as `$this` (NOT `$parent`).
  "fl.lambda": ["$env", "$input", "$var", "$auth", "$this"],
  // The array-iterating filters: one run per element.
  map: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  filter: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  some: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  every: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  find: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  findIndex: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent"],
  // …plus the accumulator, which is `$result`. This is issue #221.
  reduce: ["$env", "$input", "$var", "$auth", "$this", "$index", "$parent", "$result"],
} as const;

/** Globals a body may use that are not `$`-bindings (so the scan never sees them). */
export const LAMBDA_GLOBALS: readonly string[] = ["console", "crypto"];

/**
 * Every filter that takes a JavaScript body → which positional slot the body
 * occupies, and which binding set it runs against.
 *
 * The slot is fixed rather than looked up because it is what the guard has to
 * key on: `filter()` sees positions, not argument names. `reduce`'s body is the
 * SECOND argument (the accumulator's initial value comes first, and #221's other
 * half is exactly that slot being invisible); every other lambda filter's is the
 * first.
 *
 * `fl.transform` is deliberately absent. It takes Xano Expression Engine source,
 * not a JavaScript body, and binds the operand as `$0` rather than `$this` — so
 * validating it against THIS contract would reject correct code. It has its own
 * guard, on its own probed contract, in `./expression-arg.ts` (issue #245); a
 * `return` there is not merely refused but sometimes silently mis-evaluated.
 * `test/values/filters.test.ts` enumerates the `code`-taking filters from
 * `FILTER_SPECS` and fails if one is missing here.
 */
export const LAMBDA_CODE_FILTERS: Readonly<Record<string, { readonly slot: number; readonly surface: LambdaSurface }>> = {
  lambda: { slot: 0, surface: "fl.lambda" },
  map: { slot: 0, surface: "map" },
  filter: { slot: 0, surface: "filter" },
  some: { slot: 0, surface: "some" },
  every: { slot: 0, surface: "every" },
  find: { slot: 0, surface: "find" },
  findIndex: { slot: 0, surface: "findIndex" },
  reduce: { slot: 1, surface: "reduce" },
};

/**
 * Run the body guard on a filter's code argument, where there is one to see.
 *
 * The choke point matters more than the form: an author who never adopts `lam.*`
 * — who writes `fl.reduce(0, c.text("return $acc + $this"))`, or reaches for the
 * low-level `filter()` — gets the same answer at the same moment as one who
 * does. It fires only on an inspectable, unfiltered `const` body; a `ref`, an
 * input, or a filtered value is left alone, because the guard must not pretend
 * to check what it cannot read.
 *
 * An EMPTY body is left alone here too, though `lam.fn`/`lam.raw` refuse to
 * author one: the editor saves a freshly-added lambda with no code at all, so a
 * pulled workspace holding that default has to keep round-tripping. Authoring a
 * blank body is a mistake; carrying one that already exists is not.
 */
export function assertLambdaFilterArgs(name: string, args: ReadonlyArray<Value | undefined>): void {
  const site = LAMBDA_CODE_FILTERS[name];
  if (site === undefined) return;
  const code = args[site.slot];
  if (!isInspectableBody(code) || code.value.trim() === "") return;
  assertLambdaBody(code.value, site.surface, `fl.${name}`);
}

/**
 * The statements that take a JavaScript body → the field carrying it and the
 * bindings it runs against. One today; a table so a second cannot be added
 * without deciding its surface.
 */
export const LAMBDA_STATEMENTS: Readonly<Record<string, { readonly field: string; readonly surface: LambdaSurface }>> = {
  "mvp:lambda": { field: "code", surface: "s.lambda" },
};

/**
 * Resolve an INLINE body in a statement's code field against that statement's
 * surface, returning the authored args unchanged when there is nothing to
 * resolve. See {@link toLambdaValue}.
 */
export function coerceLambdaFields(
  storedName: string,
  authored: Record<string, unknown>,
): Record<string, unknown> {
  const site = LAMBDA_STATEMENTS[storedName];
  if (site === undefined || typeof authored[site.field] !== "function") return authored;
  return { ...authored, [site.field]: toLambdaValue(authored[site.field] as LambdaBody, site.surface, storedName === "mvp:lambda" ? "s.lambda" : storedName) };
}

/** Run the body guard on a statement's code field. See {@link assertLambdaFilterArgs}. */
export function assertLambdaStatement(storedName: string, authored: Record<string, unknown>): void {
  const site = LAMBDA_STATEMENTS[storedName];
  if (site === undefined) return;
  const code = authored[site.field];
  if (!isInspectableBody(code) || code.value.trim() === "") return;
  assertLambdaBody(code.value, site.surface, "s.lambda");
}

/**
 * Whether a value's body text can be read at all: an unfiltered `const` string.
 * A `ref`, an input binding, or a filtered value carries no text to check, and a
 * guard that fired on those would be guessing.
 */
function isInspectableBody(code: unknown): code is Value & { value: string } {
  return (
    typeof code === "object" &&
    code !== null &&
    (code as Value).tag === "const" &&
    typeof (code as Value).value === "string" &&
    ((code as Value).filters?.length ?? 0) === 0
  );
}

/**
 * Ambient request state, in scope at every surface.
 *
 * Typed `any` deliberately: `$var` holds the enclosing function's stack
 * variables and `$input` its declared inputs, and threading those inferred
 * shapes in here is a substantial type-level piece of work in its own right. The
 * value this parameter carries today is the NAMES — that a binding exists, is
 * spelled this way, and exists at this surface.
 */
export interface AmbientBindings {
  /** Workspace environment variables and request settings. */
  $env: any;
  /** The enclosing function's inputs, by name. */
  $input: any;
  /** The enclosing function's stack variables, by name — `$var.total`. A stack
   * variable is NOT also injected as a bare `$total`. */
  $var: any;
  /** The authenticated caller, when the request carries a token. */
  $auth: any;
}

/** Ambient state plus the per-element bindings of an iterating filter. */
export interface IteratingBindings extends AmbientBindings {
  /** The current element. */
  $this: any;
  /** The current element's position, from 0. */
  $index: number;
  /** The whole array the filter is applied to. */
  $parent: any;
}

/** The bindings in scope in a body at `S` — the type of a {@link lam.fn} parameter. */
export type LambdaBindings<S extends LambdaSurface = "reduce"> = S extends "reduce"
  ? IteratingBindings & {
      /** The accumulator. This is the binding issue #221 guessed as `$acc`. */
      $result: any;
    }
  : S extends "s.lambda"
    ? AmbientBindings
    : S extends "fl.lambda"
      ? AmbientBindings & {
          /** The piped value the filter is applied to. */
          $this: any;
        }
      : IteratingBindings;

/**
 * A lambda body written INLINE at the call site, where the surface is already
 * known — `fl.map(({ $this }) => $this * 2)`.
 *
 * This is the form to reach for. `lam.fn` exists for a body that is shared,
 * captured, or otherwise built away from where it runs; everywhere else the
 * call site knows which surface it is, so naming the surface a second time is
 * something for the SDK to do rather than the author. TypeScript types the
 * parameter contextually from the position, so `$this` autocompletes inside
 * `fl.map` and `$result` does not compile there.
 */
export type LambdaBody<S extends LambdaSurface = LambdaSurface> = (
  bindings: LambdaBindings<S>,
  captured: Record<string, CaptureValue>,
) => unknown;

/**
 * Accept either a {@link Value} or an inline {@link LambdaBody} wherever a
 * lambda body is taken, resolving the function form against the surface the CALL
 * SITE knows.
 *
 * A function reaching a `code` argument can only be an authored body, so this
 * needs no marker to recognize one — and the surface it validates against is the
 * one it was written at, not one the author had to restate.
 */
export function toLambdaValue<T>(x: T | LambdaBody, surface: LambdaSurface, source: string): T | Value {
  if (typeof x !== "function") return x;
  return lambdaValue(extractFunctionBody(String(x), source), { surface }, source);
}

/** A JSON value a capture entry can carry into the body. */
export type CaptureValue = string | number | boolean | null | { [k: string]: CaptureValue } | CaptureValue[];

/** Options shared by every `lam.*` form. */
export interface LambdaOptions<C extends Record<string, CaptureValue> = Record<string, never>> {
  /**
   * Which surface the body will run at, which is what decides the legal
   * bindings.
   *
   * Omit it and the check is DEFERRED to the call site, which knows the answer:
   * dropping the body into `fl.map(...)` or `s.lambda({...})` validates it there,
   * against that surface. Naming it here is for a body built away from its call
   * site — a shared constant, or one that should fail at its own definition
   * rather than at its use.
   *
   * Better still, write the body inline (`fl.map(({ $this }) => …)`), where the
   * surface is implied and TypeScript types the bindings from the position.
   */
  surface?: LambdaSurface;
  /**
   * Values from the enclosing TypeScript scope to carry into the body, emitted
   * as a `const` prelude.
   *
   * Nothing crosses the boundary implicitly: the body is extracted as TEXT and
   * runs in a different process, so a closed-over `const rate` is simply
   * undefined at runtime. Rather than guess at free variables (which needs a
   * JavaScript parser this package deliberately does not have), capture is
   * explicit and the second parameter of the body destructures it.
   */
  capture?: C;
}

// --- body extraction ------------------------------------------------------------

/** The error prefix every `lam.*` diagnostic carries, so they read as one family. */
const PREFIX = "lam";

/**
 * Extract the body text of a function from its SOURCE.
 *
 * Two forms reach here — a block body (`(b) => { … }`) and a concise expression
 * body (`(b) => expr`) — and they must produce the same text, because they are
 * the same lambda as far as the engine is concerned. The concise form becomes
 * `return <expr>;`.
 *
 * Exported so `lam.file` can extract from a file's default export with exactly
 * the same rule the inline form uses — one extraction, so the two authoring
 * forms cannot diverge.
 */
export function extractFunctionBody(source: string, caller: string): string {
  const src = source.trim();
  if (src.includes("[native code]")) {
    throw new Error(
      `${caller}: this function has no readable source (it is native, bound, or otherwise not authored here), ` +
        `so there is no body to send to the engine. Write the body inline as an arrow function, or use lam.raw(...) ` +
        `with the code as text. (issue #221)`,
    );
  }

  const mask = maskNonCode(src);

  // A `function` / `async function` form: the body is the brace block after the
  // parameter list — which itself may contain braces (`function ({ $this }) {…}`),
  // so the opener is found past the matching `)`, not by the first `{`.
  const kw = /^(?:async\s+)?function\b/.exec(src);
  if (kw) {
    const open = mask.indexOf("{", closingParen(mask, kw[0].length));
    const close = mask.lastIndexOf("}");
    if (open === -1 || close <= open) {
      throw new Error(`${caller}: could not find the function body in ${JSON.stringify(src.slice(0, 80))}.`);
    }
    assertDestructuredParams(src.slice(kw[0].length, open), mask.slice(open + 1, close), caller);
    return dedent(src.slice(open + 1, close).trim());
  }

  // Otherwise an arrow: everything after the top-level `=>`.
  const arrow = topLevelArrow(mask);
  if (arrow === -1) {
    throw new Error(
      `${caller}: expected an arrow function or a function expression, got ${JSON.stringify(src.slice(0, 80))}. ` +
        `A class method or an object shorthand method does not extract; write it as an arrow function.`,
    );
  }
  assertDestructuredParams(src.slice(0, arrow), mask.slice(arrow + 2), caller);
  const rest = src.slice(arrow + 2).trim();
  const restMask = mask.slice(arrow + 2).trim();
  if (restMask.startsWith("{")) {
    const close = restMask.lastIndexOf("}");
    if (close === -1) throw new Error(`${caller}: unbalanced braces in the function body.`);
    return dedent(rest.slice(1, close).trim());
  }
  // Concise body: `(b) => expr` is `return expr;`.
  return `return ${rest.replace(/[;,]\s*$/, "")};`;
}

/**
 * Strip the indentation an authored body inherited from where it was written.
 *
 * A lambda nested three levels deep in a workspace definition would otherwise
 * store three levels of leading spaces, and the SAME lambda moved to the top
 * level would store different bytes — a diff in a byte-exact corpus with no
 * change in meaning. The block and file forms of one body also have to agree.
 *
 * Skipped when the body contains a backtick: a multi-line template literal's
 * leading whitespace is part of its value, and no tokenizer-level check can tell
 * which lines those are without tracking the literal across the dedent.
 */
function dedent(body: string): string {
  if (body.includes("`")) return body;
  const lines = body.split("\n");
  const indents = lines.slice(1).filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const common = indents.length ? Math.min(...indents) : 0;
  if (common === 0) return body;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(common))].join("\n");
}

/**
 * Refuse a parameter the body then dereferences by name.
 *
 * The parameters are a fiction: only the BODY is sent, and the engine injects
 * the bindings as free identifiers. So `({ $this }) => $this * 2` works —
 * destructuring names the bindings and disappears — while `(b) => b.$this * 2`
 * emits `return b.$this * 2;`, and `b` is undefined at runtime. That failure
 * comes back as diagnostic text in the value slot with HTTP 200, which is the
 * exact shape of #221, so it is caught here instead.
 *
 * An unreferenced parameter is fine (`(_, { rate }) => rate`): nothing that
 * survives into the body depends on it.
 */
function assertDestructuredParams(params: string, bodyMask: string, caller: string): void {
  const inner = /\(([\s\S]*)\)/.exec(params)?.[1] ?? params;
  for (const part of splitTopLevel(inner)) {
    const name = /^\s*(?:\.\.\.)?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(part)?.[1];
    // A destructuring pattern (`{ … }` / `[ … ]`) has no leading identifier.
    if (name === undefined) continue;
    const referenced = new RegExp(`(^|[^A-Za-z0-9_$.])${name.replace(/\$/g, "\\$")}\\b`).test(bodyMask);
    if (!referenced) continue;
    throw new Error(
      `${caller}: the body reads \`${name}\`, but a lambda's parameters are not real — only the BODY is sent, and ` +
        `the engine injects the bindings as free identifiers. DESTRUCTURE them instead: ` +
        `\`({ ${name === "b" ? "$this" : name} }) => …\` rather than \`(${name}) => … ${name}.$this …\`. As written, ` +
        `\`${name}\` is undefined at runtime and the engine returns that failure as text in the value slot. ` +
        `(issue #221)`,
    );
  }
}

/** Split a parameter list on its top-level commas. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Index just past the `)` closing the parameter list that opens at or after `from`. */
function closingParen(mask: string, from: number): number {
  const open = mask.indexOf("(", from);
  if (open === -1) return from;
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === "(") depth++;
    else if (mask[i] === ")" && --depth === 0) return i + 1;
  }
  return from;
}

/** Index of the `=>` that separates the parameter list from the body, or -1. */
function topLevelArrow(mask: string): number {
  let depth = 0;
  for (let i = 0; i < mask.length - 1; i++) {
    const ch = mask[i] ?? "";
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === "=" && mask[i + 1] === ">") return i;
  }
  return -1;
}

// --- the scan --------------------------------------------------------------------

/**
 * Blank out everything that is not code — string bodies, comments, and regex
 * literal bodies — replacing each character with a space so every index still
 * lines up with the original. A template literal's `${…}` substitutions are NOT
 * blanked: they are code, and `` `${$var.x}` `` has to resolve `$var` as a real
 * binding reference.
 *
 * Exported for `lam.file`, which scans a module's top level with it.
 *
 * This is a tokenizer, not a parser. The SDK ships two runtime dependencies and
 * is not going to gain a JavaScript parser for this; what the scan needs is only
 * to know which `$identifier` occurrences are real references. Where the regex/
 * division ambiguity is genuinely undecidable without a parser, it errs toward
 * treating the text as code — a missed `$` in a regex body would at worst report
 * a binding that is not there, and the tests pin the shapes that matter.
 */
export function maskNonCode(src: string): string {
  const out: string[] = [];
  // Template-literal nesting: each entry is the depth of `{` inside a `${…}`.
  const templates: number[] = [];
  let i = 0;
  // The last significant character, and the identifier immediately before the
  // cursor — together they decide whether a `/` opens a regex or divides. A
  // masked character (a string's closing quote, say) counts as significant, so
  // `"abc" / 2` is read as division rather than as a regex.
  let prevSignificant = "";
  let prevWord = "";

  /** The character at `k`, or "" past the end — the scan reads one char ahead. */
  const at = (k: number): string => src[k] ?? "";
  /** Current template state: -1 in literal text, >0 inside a `${…}` at that brace depth. */
  const top = (): number => templates[templates.length - 1] ?? 0;
  const setTop = (v: number): void => {
    templates[templates.length - 1] = v;
  };

  const push = (ch: string, masked = false): void => {
    out.push(masked ? (ch === "\n" ? "\n" : " ") : ch);
    if (/\s/.test(ch)) return;
    prevSignificant = ch;
    if (!masked && /[A-Za-z0-9_$]/.test(ch)) prevWord += ch;
    else prevWord = "";
  };

  /** Keywords a regex literal may directly follow (`return /re/`, `typeof /re/`). */
  const REGEX_PRECEDING_KEYWORDS = new Set([
    "return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await",
  ]);

  while (i < src.length) {
    const ch = at(i);
    const next = at(i + 1);

    // Inside a template's `${…}`: track braces so the closing one returns us to
    // the literal.
    if (templates.length > 0 && top() >= 0) {
      if (ch === "{") setTop(top() + 1);
      else if (ch === "}") {
        setTop(top() - 1);
        if (top() === 0) {
          // Back to literal text.
          setTop(-1);
          push(ch, true);
          i++;
          continue;
        }
      }
    }

    // Template literal text.
    if (templates.length > 0 && top() === -1) {
      if (ch === "\\") {
        push(ch, true);
        push(at(i + 1), true);
        i += 2;
        continue;
      }
      if (ch === "`") {
        templates.pop();
        push(ch, true);
        i++;
        continue;
      }
      if (ch === "$" && next === "{") {
        setTop(1);
        push(ch, true);
        push("{", true);
        i += 2;
        continue;
      }
      push(ch, true);
      i++;
      continue;
    }

    // Line comment.
    if (ch === "/" && next === "/") {
      while (i < src.length && at(i) !== "\n") push(at(i++), true);
      continue;
    }
    // Block comment.
    if (ch === "/" && next === "*") {
      push(at(i++), true);
      push(at(i++), true);
      while (i < src.length && !(at(i) === "*" && at(i + 1) === "/")) push(at(i++), true);
      if (i < src.length) {
        push(at(i++), true);
        push(at(i++), true);
      }
      continue;
    }
    // Quoted string.
    if (ch === '"' || ch === "'") {
      push(ch, true);
      i++;
      while (i < src.length && at(i) !== ch) {
        if (at(i) === "\\") push(at(i++), true);
        if (i < src.length) push(at(i++), true);
      }
      if (i < src.length) push(at(i++), true);
      continue;
    }
    // Template literal opener.
    if (ch === "`") {
      templates.push(-1);
      push(ch, true);
      i++;
      continue;
    }
    // Regex literal — only where a value may start, which is the standard
    // heuristic for telling `/` apart from division.
    if (
      ch === "/" &&
      (prevSignificant === "" ||
        REGEX_PRECEDING_KEYWORDS.has(prevWord) ||
        (prevWord === "" && "(,=:[!&|?{};+-*%~^<>".includes(prevSignificant)))
    ) {
      push(ch, true);
      i++;
      let closed = false;
      while (i < src.length && at(i) !== "\n") {
        if (at(i) === "\\") {
          push(at(i++), true);
          if (i < src.length) push(at(i++), true);
          continue;
        }
        if (at(i) === "[") {
          while (i < src.length && at(i) !== "]" && at(i) !== "\n") push(at(i++), true);
          continue;
        }
        if (at(i) === "/") {
          push(at(i++), true);
          closed = true;
          break;
        }
        push(at(i++), true);
      }
      if (!closed) {
        // Not a regex after all (an unterminated one is a syntax error, so this
        // was division). Nothing to undo — the characters are already masked, and
        // a `$` inside arithmetic is not a binding reference either way.
      }
      continue;
    }
    push(ch);
    i++;
  }
  return out.join("");
}

/**
 * Every `$identifier` the body DECLARES for itself — a local, a parameter, a
 * catch binding.
 *
 * `$` is a legal identifier character, so a body may perfectly well write
 * `const $tmp = …` or `$parent.map(($x) => $x + 1)`. Those are not engine
 * bindings and flagging them would be a build error on correct code, which is
 * the worst failure this guard can have. Declaration sites are recognized
 * rather than parsed — the four shapes below cover what a lambda body actually
 * writes — and anything recognized is excluded from the scan.
 */
function declaredLocals(mask: string): Set<string> {
  const declared = new Set<string>();
  const add = (text: string | undefined): void => {
    for (const m of (text ?? "").matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g)) declared.add(m[0]);
  };
  // `const $x = …`, `let $a = 1, $b = 2`, `const { $a, $b } = …`. Each declarator
  // contributes only the text BEFORE its `=`: an initializer may legitimately
  // mention a real binding (`const $x = $acc`), and treating that as a
  // declaration would whitelist the very name the scan exists to catch.
  for (const m of mask.matchAll(/\b(?:const|let|var)\s+([^;\n]+)/g)) {
    for (const declarator of (m[1] ?? "").split(",")) add(declarator.split("=")[0]);
  }
  for (const m of mask.matchAll(/\b(?:function|class)\s+(\$[A-Za-z0-9_]*)/g)) add(m[1]);
  for (const m of mask.matchAll(/\bcatch\s*\(([^)]*)\)/g)) add(m[1]);
  // Arrow parameters: `($x) => …`, `$x => …`, `async ($x, { $y }) => …`.
  for (const m of mask.matchAll(/(\([^()]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)) add(m[1]);
  // `function (…)` / method parameter lists.
  for (const m of mask.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) add(m[1]);
  return declared;
}

/** Every distinct `$identifier` referenced as code, in source order. Takes the
 * MASKED body, so one mask serves both checks in {@link assertLambdaBody}. */
function dollarTokens(mask: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Not preceded by an identifier character, so `a.$x` (a property) and `x$y`
  // (part of a longer name) are not references to a `$x` binding.
  for (const m of mask.matchAll(/(^|[^A-Za-z0-9_$.])(\$[A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[2] ?? "";
    if (name !== "" && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * The binding an unknown `$identifier` most likely meant, or undefined.
 *
 * Answers with the real name where one is knowable: `$acc` for `$result` (the
 * #221 spelling, plus the other accumulator names an author reaches for), and
 * otherwise a same-name binding that exists at a DIFFERENT surface — which is
 * the second real failure, reusing a `map` body inside `s.lambda`.
 */
function suggestion(token: string, surface: LambdaSurface): string | undefined {
  const ACCUMULATOR_GUESSES = ["$acc", "$accumulator", "$carry", "$memo", "$total", "$prev", "$previous"];
  if (ACCUMULATOR_GUESSES.includes(token) && LAMBDA_BINDINGS[surface].includes("$result")) {
    return `\`$result\` is the accumulator at this surface`;
  }
  if (ACCUMULATOR_GUESSES.includes(token)) {
    return `\`$result\` is the accumulator, and only \`reduce\` binds it`;
  }
  const elsewhere = (Object.keys(LAMBDA_BINDINGS) as LambdaSurface[]).filter((s) =>
    LAMBDA_BINDINGS[s].includes(token),
  );
  if (elsewhere.length) return `\`${token}\` is bound at ${elsewhere.join(", ")}, but not here`;
  if (token === "$parent" || token === "$this") {
    return `the value a filter is applied to is \`$this\` in \`fl.lambda\`, and \`$parent\` in the array-iterating filters`;
  }
  return undefined;
}

/**
 * Reject a body that cannot work at `surface`, before it can reach a live
 * request. Three failures are unwritable after this:
 *
 * 1. an `$identifier` outside the surface's binding set — provably undefined at
 *    runtime, because a stack variable is only ever reachable as `$var.name`;
 * 2. a top-level `import`/`export`, which is a syntax error in a function body
 *    (dependencies are reached through dynamic `import()`);
 * 3. an empty body, which stores a statement the engine refuses at import.
 *
 * Exported so the statement and filter factories can run the same check on a
 * plain `c.text(...)` body — an author who never adopts `lam.*` gets the same
 * answer at the same moment.
 */
export function assertLambdaBody(body: string, surface: LambdaSurface, source = `${PREFIX}.fn`): void {
  if (body.trim() === "") {
    throw new Error(
      `${source}: the lambda body is empty. A lambda must return a value — the engine refuses a statement with no code. (issue #221)`,
    );
  }

  const mask = maskNonCode(body);
  const legal = LAMBDA_BINDINGS[surface];
  const locals = declaredLocals(mask);
  for (const token of dollarTokens(mask)) {
    if (legal.includes(token) || locals.has(token)) continue;
    const hint = suggestion(token, surface);
    throw new Error(
      `${source}: \`${token}\` is not a binding in a \`${surface}\` lambda body${hint ? ` — ${hint}` : ""}. ` +
        `It is undefined at runtime, and a lambda that throws comes back as its own diagnostic TEXT in the value ` +
        `slot with HTTP 200, so the failure reads as bad data rather than an error. ` +
        `Bound here: ${legal.join(", ")} (plus the ${LAMBDA_GLOBALS.join(" / ")} globals). ` +
        `A stack variable is reached as \`$var.name\`, never as \`$name\`. (issue #221)`,
    );
  }

  // `import(` / `import.meta` are the dynamic forms and stay legal; a bare
  // `import`/`export` keyword in statement position is the module-only syntax the
  // engine rejects outright.
  const moduleSyntax = /(^|[;{}\n])\s*(import|export)\b(?![\s]*[.(])/.exec(mask);
  if (moduleSyntax) {
    const kw = moduleSyntax[2];
    throw new Error(
      `${source}: a top-level \`${kw}\` is a syntax error in a lambda body — the body is a function body, not a ` +
        `module, so it must \`return\` its value and cannot declare module syntax. Reach a dependency with dynamic ` +
        `\`import()\` instead: \`const m = await import("...")\`. (issue #221)`,
    );
  }
}

// --- capture ------------------------------------------------------------------------

/** Serialize the capture list as the `const` prelude that opens the body.
 * Exported so every `lam.*` form emits an identical prelude. */
export function capturePrelude(capture: Record<string, unknown> | undefined, source: string): string {
  if (capture === undefined) return "";
  const lines: string[] = [];
  for (const [name, value] of Object.entries(capture)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(`${source}: capture key ${JSON.stringify(name)} is not a valid JavaScript identifier.`);
    }
    const type = typeof value;
    if (type === "function" || type === "symbol" || type === "bigint" || type === "undefined") {
      throw new Error(
        `${source}: capture \`${name}\` is a ${type}, which cannot cross into the engine — the body is sent as TEXT ` +
          `and runs in a different process. Capture JSON data (string, number, boolean, null, object, array); for ` +
          `behaviour, inline it in the body. (issue #221)`,
      );
    }
    lines.push(`const ${name} = ${JSON.stringify(value)};`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

// --- the surface ------------------------------------------------------------------------

/**
 * The last step of every `lam.*` form: prepend the capture prelude, validate for
 * the surface, and emit the `const:text` a hand-written `c.text(...)` produced.
 *
 * One function so the three authoring forms cannot drift apart — a body that
 * `lam.fn` accepts is one `lam.raw` and `lam.file` accept, byte for byte.
 */
export function lambdaValue(
  body: string,
  opts: LambdaOptions<Record<string, CaptureValue>> | undefined,
  source: string,
): Value {
  const code = capturePrelude(opts?.capture, source) + body;
  // No surface named: the call site validates, and it is the one that knows.
  // What comes back is an ordinary `const:text`, so the statement and filter
  // guards see it exactly as they see a hand-written `c.text(...)`.
  if (opts?.surface !== undefined) assertLambdaBody(code, opts.surface, source);
  return c.text(code);
}

/**
 * Author a lambda body as a typed TypeScript function.
 *
 * The first parameter destructures the bindings for the surface, so the editor
 * supplies them and a wrong name is a compile error rather than a wrong value at
 * runtime. The body is extracted at author time and emitted as the same
 * `const:text` a hand-written `c.text(...)` produced.
 *
 * ```ts
 * lam.fn(({ $result, $this }) => $result + $this)                 // reduce
 * lam.fn(({ $var }) => $var.subtotal * 1.2, { surface: "s.lambda" })
 * lam.fn(({ $this }, { rate }) => $this * rate, { surface: "map", capture: { rate } })
 * ```
 *
 * Nothing from the enclosing scope crosses implicitly — a closed-over value is
 * undefined at runtime — so anything the body needs from outside goes in
 * `capture` and arrives as the second parameter.
 */
function fn<S extends LambdaSurface = "reduce", C extends Record<string, CaptureValue> = Record<string, never>>(
  body: (bindings: LambdaBindings<S>, captured: C) => unknown,
  opts?: LambdaOptions<C> & { surface?: S },
): Value {
  return lambdaValue(extractFunctionBody(String(body), `${PREFIX}.fn`), opts, `${PREFIX}.fn`);
}

/**
 * The escape hatch: a lambda body as text, validated exactly like {@link fn}.
 *
 * For a body that genuinely cannot be an authored function — one assembled at
 * build time, or lifted verbatim out of a pulled workspace. It is guarded, not
 * extracted, so the guard cannot be sidestepped by choosing this form.
 */
function raw(code: string, opts?: LambdaOptions<Record<string, CaptureValue>>): Value {
  return lambdaValue(code, opts, `${PREFIX}.raw`);
}

/**
 * Lambda authoring. `lam.fn` for an inline typed body, `lam.raw` for text, and
 * `lam.file` (from `@sidestep/core/node`) for a body big enough to want its own
 * type-checked module. All three produce the same `const:text` {@link Value} and
 * pass the same validation.
 */
export const lam = { fn, raw };
