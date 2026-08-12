/**
 * Value decoder — stored `{value, tag, filters}` → SideStep source expression.
 *
 * Every candidate expression is **proved before it is emitted**: the decoder
 * builds the readable form by calling the real `c.*` / `ref` / `withFilters`
 * constructors, then compares what they produced against the stored value. Only
 * an exact match is emitted; anything else falls back to `rawValue(...)`, which
 * is verbatim by construction. So a wrong guess degrades readability, never
 * fidelity — and the same check absorbs the encoder's own guards (the issue #128
 * regex-pattern throw, the `c.obj` nested-value rejection) without restating them.
 *
 * Expression values (`const:expr` / `const:expr2`) are decoded as SOURCE, not as
 * structure: `obj()` is tried first because it is the checked form, and anything
 * else comes back through `c.expression` / `c.expressionLegacy`, which carry the
 * expression string verbatim. Exact either way — the difference is only whether
 * the emitted call type-checks its contents. A structured decoder for the
 * expression grammar remains out of scope.
 */
import type { FilterXdo, TaggedValue } from "../types/xdo.js";
import { TAGS } from "../types/xdo.js";
import { auth, c, caught, col, env, inp, out, ref, setting, withFilters } from "../values/value.js";
import type { BlankTag, Value } from "../values/value.js";
import { FILTER_NAMES, FILTER_REQUIRED_ARGS, fl } from "../values/generated/filters.generated.js";
import { obj as objValue } from "../values/obj.js";
import { parseObjExpr } from "./obj-expr.js";
import { CODEGEN_MODULE, CORE_MODULE, type DecodeContext } from "./context.js";
import { call, lit, obj, type Expr } from "./print.js";
import { normalize } from "../validate/normalize.js";

/** A proposed decoding: the source to emit, what it re-encodes to, and its imports. */
interface Candidate {
  readonly expr: Expr;
  readonly value: Value;
  /** Symbols the expression needs from `@sidestep/core`. */
  readonly symbols: readonly string[];
}

/** Structural equality over stored JSON. Key order is irrelevant; presence is not. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.hasOwn(b as object, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Run a constructor, treating any encoder guard it trips as "not decodable". */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Value/filter equality under the round-trip contract's own comparator.
 *
 * The proof this decoder rests on is "the constructor reproduces what was
 * stored" — and what counts as reproduced is `normalize`, the same oracle
 * `sidestep validate` and codegen verification use. Comparing raw instead made
 * the decoder stricter than the contract, and two generational artifacts it
 * already absorbs were enough to send an otherwise-decodable value to
 * `rawValue()`:
 *
 * - a numeric `value` (`{value: 12, tag:"const:int"}`) where the SDK writes the
 *   string form — the single most common shape in the wild;
 * - a filter stored without `disabled`, which `filter()` always writes. That one
 *   is doubly costly: it also fails the whole-chain check below, so ONE
 *   old-vintage filter dragged its entire value down with it.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return deepEqual(normalize(a), normalize(b));
}

/** The pattern-piped regex filters — the ones whose piped value IS the pattern. */
const REGEX_PATTERN_FILTERS = new Set([
  "regex_test",
  "regex_match",
  "regex_match_all",
  "regex_matches",
  "regex_replace",
  "regex_get_all_matches",
  "regex_get_first_match",
]);

/**
 * A `const:obj` stored with no content at all: `""` (most of them) or `null`.
 * Both are the pre-`{}` empty form — see the decode branch for what happens to
 * them and why it is reported.
 */
export function isBlankObject(value: unknown): boolean {
  return value === "" || value === null;
}

/** Split a `/body/flags` literal. Null when the value is not in that form. */
function splitSlashRegex(value: string): { body: string; flags: string } | null {
  const m = /^\/(.*)\/([a-zA-Z]*)$/s.exec(value);
  return m ? { body: m[1]!, flags: m[2]! } : null;
}

/**
 * True for a tag whose blank form `c.blank` spells.
 *
 * Tested against the constructor's own accepted set rather than a list repeated
 * here, so the decoder cannot offer a spelling the authoring surface rejects.
 */
function isBlankTag(tag: string): tag is BlankTag {
  return tag.startsWith("const") && tag !== "const" && tag !== "const:obj";
}

/**
 * Decode the un-filtered base of a value.
 *
 * `regexPiped` says the first filter in the chain treats this value as a regex
 * pattern — which is the only context where `c.regex` is the right surface and,
 * not coincidentally, the context where a bare `c.text` pattern is a live bug.
 */
function decodeBase(v: TaggedValue, regexPiped: boolean): Candidate | null {
  const bare = { value: v.value, tag: v.tag, filters: [] };
  const propose = (expr: Expr, built: Value | null, ...symbols: string[]): Candidate | null =>
    built && sameValue(built, bare) ? { expr, value: built, symbols } : null;

  // The editor's unconfigured value box, taken before the per-tag arms because
  // several of them would otherwise coerce it into something it is not:
  // `Number("")` is 0, so a blank `const:int` would propose `c.int(0)` and only
  // the byte comparison inside `propose` would catch it. Naming the state up
  // front is clearer than relying on that, and it is what `c.blank` spells.
  //
  // `const` and `const:obj` are absent from `BlankTag` because their blanks
  // already round-trip exactly (`c.text("")`, `c.obj(null)`), so they fall
  // through to the arms below unchanged.
  const blankTag = v.value === "" && isBlankTag(v.tag) ? v.tag : null;
  if (blankTag) {
    return propose(call("c.blank", lit(blankTag)), attempt(() => c.blank(blankTag)), "c");
  }

  switch (v.tag) {
    case "const": {
      if (regexPiped) {
        const parts = splitSlashRegex(v.value);
        if (parts) {
          const args = parts.flags ? [lit(parts.body), lit(parts.flags)] : [lit(parts.body)];
          const built = attempt(() => c.regex(parts.body, parts.flags));
          const candidate = propose(call("c.regex", ...args), built, "c");
          if (candidate) return candidate;
        }
        // A bare pattern here is exactly what `withFilters` refuses to encode, so
        // there is no readable form — the caller falls back and reports.
        return null;
      }
      return propose(call("c.text", lit(v.value)), c.text(v.value), "c");
    }
    case "const:int": {
      const n = Number(v.value);
      return Number.isFinite(n) ? propose(call("c.int", lit(n)), c.int(n), "c") : null;
    }
    case "const:decimal": {
      const n = Number(v.value);
      if (!Number.isFinite(n)) return null;
      const asNumber = propose(call("c.decimal", lit(n)), c.decimal(n), "c");
      if (asNumber) return asNumber;
      // The number form did not reproduce the stored bytes, which for a decimal
      // means a spelling no numeric literal carries — `"10.00"` stringifies as
      // `"10"`. The engine stores decimals as strings, so passing the stored
      // string through is exact. Tried second so the readable form stays the
      // default and this is reserved for what it cannot express.
      return propose(call("c.decimal", lit(v.value)), c.decimal(v.value), "c");
    }
    case "const:bool": {
      const b = v.value === "true";
      return propose(call("c.bool", lit(b)), c.bool(b), "c");
    }
    case "const:null":
      return propose(call("c.null"), c.null(), "c");
    // The engine's native current-time constant. `c.now()` is the only authoring
    // form, and it only reproduces `value:"now"` — every occurrence in a real
    // workspace is exactly that, and any other value falls through to `rawValue`
    // rather than being decoded as a "now" it is not.
    case "const:epochms":
      return propose(call("c.now"), c.now(), "c");
    case "const:array":
    case "const:obj": {
      // A BLANK object constant — `value:""` or `value:null` — is the shape the
      // editor stopped writing long ago; a new object variable starts at `{}`
      // today. It is NOT the same value: the engine JSON-decodes the stored
      // string, so a blank yields null where `{}` yields an empty object.
      //
      // So it comes back as `c.obj(null)`, which reproduces the stored bytes
      // exactly. It used to come back as `c.obj()` — readable, but it re-pointed
      // 113 statements in the survey corpus at `{}` on the next deploy, behind a
      // `modernized` warning. An exact spelling costs nothing and needs no
      // warning, and it is what the sibling blank tags already do (a blank
      // `const:int` is carried verbatim for the same reason).
      if (v.tag === "const:obj" && isBlankObject(v.value)) {
        return propose(call("c.obj", lit(null)), attempt(() => c.obj(null)), "c");
      }
      const parsed = attempt(() => JSON.parse(v.value) as unknown);
      if (parsed === null && v.value !== "null") return null;
      const isArray = Array.isArray(parsed);
      if (isArray !== (v.tag === "const:array")) return null;
      const built = attempt(() =>
        isArray ? c.array(parsed as never) : c.obj(parsed as never),
      );
      return propose(call(isArray ? "c.array" : "c.obj", lit(parsed)), built, "c");
    }
    case "var":
      return propose(call("ref", lit(v.value)), ref(v.value), "ref");
    case "input":
      return propose(call("inp", lit(v.value)), inp(v.value), "inp");
    case "auth":
      return propose(call("auth", lit(v.value)), auth(v.value), "auth");
    case "col":
      return propose(call("col", lit(v.value)), col(v.value), "col");
    case "trycatch":
      return propose(call("caught", lit(v.value)), caught(v.value as never), "caught");
    case "output":
      return propose(call("out", lit(v.value)), out(v.value), "out");
    case "setting": {
      // Built-in request/system vars carry a `$` prefix and are settings; a plain
      // name is a workspace env var, whose idiomatic surface is `env(...)`. Both
      // encode identically, so this is a readability split, not a semantic one.
      const isEnvVar = !v.value.startsWith("$");
      return isEnvVar
        ? propose(call("env", lit(v.value)), env(v.value), "env")
        : propose(call("setting", lit(v.value)), setting(v.value), "setting");
    }
    // The older expression form. `obj()` always emits `const:expr2`, so no
    // object-building path can reproduce this tag — but `c.expressionLegacy` carries
    // the source verbatim, which is both exact and readable.
    case "const:expr":
      return propose(call("c.expressionLegacy", lit(v.value)), attempt(() => c.expressionLegacy(v.value)), "c");
    case "const:expr2": {
      // A dynamic object, stored as its rendered XanoScript expression string.
      // `obj()` is the authoring constructor, so the inverse is a parse — scoped
      // to exactly the grammar `obj()` emits (see `obj-expr.ts`).
      //
      // `propose` is the proof: it re-runs the real `obj()` over the parsed
      // record and requires the re-rendered string to equal the stored one, so a
      // parser that mis-reads an expression yields `null` and falls back to
      // `rawValue` rather than emitting a plausible-but-different value.
      const parsed = parseObjExpr(v.value);
      if (parsed) {
        const built = attempt(() => objValue(parsed.built));
        const candidate = propose(parsed.expr, built, ...parsed.symbols);
        if (candidate) return candidate;
      }
      // Not the object grammar (or the parse did not prove out): the expression
      // is some other expression-engine source — `~` concatenation, arithmetic,
      // a conditional. `c.expression` carries it verbatim, which beats
      // `rawValue` on readability and is exactly as faithful. `obj()` stays
      // preferred above because it is the CHECKED form; this is the passthrough.
      return propose(call("c.expression", lit(v.value)), attempt(() => c.expression(v.value)), "c");
    }
    default:
      // `response`, `toolset` — engine-side tags with no authoring constructor.
      return null;
  }
}

/** `fl.<name>` when the name is a plain identifier, `fl["…"]` otherwise. */
function filterCallee(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `fl.${name}` : `fl[${JSON.stringify(name)}]`;
}

/**
 * The verbatim form of one filter: the stored object, passed straight to
 * `withFilters` (which accepts a `FilterXdo` as well as an `fl.*` result).
 *
 * The escape hatch for a filter the catalog cannot rebuild exactly — most often
 * one the engine stored WITHOUT `disabled`, since `filter()` always writes it.
 * Degrading the single filter keeps the rest of the value readable
 * (`withFilters(ref("answers"), {…})`) instead of collapsing the whole thing to
 * `rawValue`, which is what happened before.
 */
function literalFilter(stored: FilterXdo): Candidate {
  return {
    expr: lit(stored),
    value: { value: "", tag: "const", filters: [] },
    symbols: [],
  };
}

/** Decode one stored filter to its `fl.*` call, or to a verbatim literal. */
function decodeFilter(stored: FilterXdo): Candidate | null {
  const known = (FILTER_NAMES as readonly string[]).includes(stored.name);
  // `filter()` hard-codes `disabled: false`, so a filter stored without that key
  // — or with it true — has no `fl.*` form and rides through verbatim instead.
  if (!known || (stored.disabled ?? false) !== false || !Array.isArray(stored.arg)) {
    return literalFilter(stored);
  }
  // A stored call with fewer arguments than the engine requires is a call the
  // typed factory refuses to spell (issue #221): the omitted slot is a LEADING
  // one, so writing it positionally would put the next argument in the wrong
  // place. The stored bytes are still the stored bytes, so it rides through
  // verbatim rather than being reshaped into a call that would not compile.
  if (stored.arg.length < (FILTER_REQUIRED_ARGS[stored.name] ?? 0)) {
    return literalFilter(stored);
  }

  const args: Expr[] = [];
  const symbols = new Set<string>(["fl"]);
  const built: Value[] = [];
  for (const arg of stored.arg) {
    const candidate = decodeValueCandidate(arg);
    if (!candidate) return literalFilter(stored);
    args.push(candidate.expr);
    built.push(candidate.value);
    for (const symbol of candidate.symbols) symbols.add(symbol);
  }

  const factory = (fl as Record<string, (...a: Value[]) => FilterXdo>)[stored.name];
  const encoded = factory ? attempt(() => factory(...built)) : null;
  if (!encoded || !sameValue(encoded, stored)) return literalFilter(stored);
  return {
    expr: call(filterCallee(stored.name), ...args),
    // A filter is not a value; the caller only reads `expr`/`symbols` here.
    value: { value: "", tag: "const", filters: [] },
    symbols: [...symbols],
  };
}

/** Build the readable form of a value, or null when none is provably exact. */
function decodeValueCandidate(v: TaggedValue): Candidate | null {
  const filters = Array.isArray(v.filters) ? v.filters : [];
  const first = filters[0];
  const base = decodeBase(v, first !== undefined && REGEX_PATTERN_FILTERS.has(first.name));
  if (!base) return null;
  if (filters.length === 0) return base;

  const symbols = new Set<string>([...base.symbols, "withFilters"]);
  const filterExprs: Expr[] = [];
  const builtFilters: FilterXdo[] = [];
  for (const stored of filters) {
    const decoded = decodeFilter(stored);
    if (!decoded) return null;
    filterExprs.push(decoded.expr);
    builtFilters.push(stored);
    for (const symbol of decoded.symbols) symbols.add(symbol);
  }

  // `withFilters` can refuse the chain outright (the regex-pattern guard); when it
  // does, there is no source form that both compiles and re-encodes to this value.
  const built = attempt(() => withFilters(base.value, ...builtFilters));
  if (!built || !sameValue(built, v)) return null;
  return {
    expr: call("withFilters", base.expr, ...filterExprs),
    value: built,
    symbols: [...symbols],
  };
}

/** The verbatim `rawValue({…})` form, exact for any stored value. */
function fallbackExpr(v: TaggedValue): Expr {
  const entries: Array<[string, Expr]> = [
    ["value", lit(v.value)],
    ["tag", lit(v.tag)],
  ];
  if (Array.isArray(v.filters) && v.filters.length > 0) entries.push(["filters", lit(v.filters)]);
  return call("rawValue", obj(entries));
}

/**
 * Decode a stored value to a source expression, recording the imports it needs
 * and reporting anything that had to fall back to a verbatim literal.
 */
export function decodeValue(ctx: DecodeContext, v: TaggedValue): Expr {
  const candidate = decodeValueCandidate(v);
  if (candidate) {
    for (const symbol of candidate.symbols) ctx.use(CORE_MODULE, symbol);
    return candidate.expr;
  }
  ctx.use(CODEGEN_MODULE, "rawValue");
  ctx.problem("value-fallback", describeFallback(v));
  return fallbackExpr(v);
}

/**
 * Why a stored value had no readable form — the cause, not just the tag.
 *
 * "tag const:int has no idiomatic form" reads as though the SDK cannot express
 * integer constants, which it plainly can. Naming the real cause is what lets
 * the category be clustered instead of merely counted — the same move that
 * turned the `rawField()` and `raw()` piles into named decisions.
 *
 * The two causes that used to dominate this function are gone: a blank constant
 * is `c.blank(tag)` now and a `"10.00"` decimal is `c.decimal("10.00")`, so
 * neither reaches a fallback at all. What remains for a blank value is a blank
 * REFERENCE — an `input`/`var`/`response` naming nothing — which is an unbound
 * binding rather than an empty value box, and must not borrow that wording.
 */
function describeFallback(v: TaggedValue): string {
  if (!(TAGS as readonly string[]).includes(v.tag)) {
    return `unknown tag ${v.tag} has no idiomatic form; emitted verbatim`;
  }
  if (v.value === "") {
    return (
      `a blank ${v.tag} — a reference that names nothing, so there is no target to resolve and no ` +
      `\`${v.tag}\` constructor call that would mean this. Carried verbatim so it keeps meaning ` +
      `exactly what it stores; bind it upstream to give it one`
    );
  }
  return `tag ${v.tag} stores ${JSON.stringify(v.value)}, which no \`c.*\` constructor reproduces exactly; emitted verbatim`;
}
