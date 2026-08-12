/**
 * The shared tagged-value primitive (KTD-2). Every place a function references
 * data — input bindings, statement context, response — uses this `{value, tag,
 * filters}` shape. Built and tested once here, reused everywhere.
 */
import type { FilterXdo, TaggedValue, Tag } from "../types/xdo.js";
import { TAGS } from "../types/xdo.js";
// The lambda-body guard, applied in `filter()` below. The cycle back to this
// module is deliberate and safe: `lambda.ts` reaches `c` only at call time.
import { assertLambdaFilterArgs } from "./lambda.js";

/** A sidestep authored value is just the stored tagged-value shape. */
export type Value = TaggedValue;

/**
 * A {@link Value} that also carries, **at the type level only**, the name of the
 * stack variable it references (`ref("user")` → `RefValue<"user">`). The `__ref`
 * carrier is phantom — never present at runtime — and required (not optional) so
 * `InferResponse`'s trace (U5) matches only real refs, never a plain `Value`.
 * Because it is a subtype of `Value`, every existing `ref(...)` use — filter
 * args, `db.query` `where`, response fields — keeps type-checking unchanged.
 */
export type RefValue<Name extends string = string> = Value & { readonly __ref: Name };

/**
 * A {@link Value} that has had a filter chain attached (`withFilters(...)`).
 * The `__filtered` carrier is phantom (type-only). A filter can reshape the
 * value arbitrarily at runtime — turn an object into a scalar, add or drop keys
 * — with no static signal, so `InferResponse` treats a filtered response value
 * as `unknown` (the honest floor, matching how the Xano engine degrades a
 * filtered result to `json`). Overriding via `responseShape` remains available.
 */
export type FilteredValue = Value & { readonly __filtered: true };

/**
 * A {@link Value} produced by {@link col} (or a filter chain built from one). The
 * `__col` carrier is phantom (type-only). It exists so a `col()` reference can be
 * *statically rejected* where it would silently fail at runtime: inside a
 * `db.edit`/`db.add` `row`, `{tag:"col"}` does not resolve to the row's stored
 * value — it evaluates to `null`, so a following `fl.add(1)` computes `null + 1`
 * and the engine aborts ("Numbers are required for mathematical operations",
 * issue #32). `col()` is only meaningful in a `db.query` `where`/view expression.
 */
export type ColValue = Value & { readonly __col: true };

/**
 * The error branch surfaced when a tagged {@link Value} is nested inside a
 * `c.obj`/`c.array` literal (issue #42). The long message is the *property key*
 * so TypeScript prints it verbatim in the "property … is missing" diagnostic; a
 * `Value` has no such key, so intersecting it here makes the offending position
 * fail to type-check. The runtime guard ({@link assertPlainJson}) carries the
 * same guidance for JS/`any`-typed callers the type can't reach.
 */
type TaggedValueNotAllowed = {
  "❌ c.obj/c.array take plain JSON only — a tagged value (inp/ref/auth/col/c.*) can't be nested. For a computed object response use a record of values: `response: { key: value }` (not c.obj). See issue #42.": never;
};

/**
 * Recursively reject any nested {@link Value} in a plain-JSON literal `T`. A
 * member assignable to `Value` maps to {@link TaggedValueNotAllowed}; plain JSON
 * (primitives, arrays, objects) passes through unchanged. Used intersected with
 * a naked `T` (`o: T & RejectValues<T>`) so `T` stays inferrable while the
 * rejection rides along. Structural `extends Value` detection — not a `JsonLiteral`
 * constraint — so it survives a future `TaggedValue` interface→alias refactor.
 */
type RejectValues<T> = T extends Value
  ? TaggedValueNotAllowed
  : T extends readonly (infer E)[]
    ? readonly RejectValues<E>[]
    : T extends object
      ? { [K in keyof T]: RejectValues<T[K]> }
      : T;

/** Runtime-guard message (issue #42). Context-neutral: `c.obj`/`c.array` are
 * general constant constructors, used well beyond responses. */
const REJECT_TAGGED_VALUE =
  "c.obj/c.array embed a plain JSON constant and cannot contain a tagged value " +
  "(inp/ref/auth/col/env/c.int/c.text/c.bool/…) — those serialize as internal " +
  "representation the engine can't decode. For a computed object response, use a " +
  "record of values — `response: { key: value }` — not `c.obj({ key: value })`. (issue #42)";

/**
 * Shape check matching {@link Value}: a `{value, tag, filters}` object whose
 * `tag` is an actual {@link Tag}. Requiring a valid tag (not merely any string)
 * keeps the runtime guard in lockstep with the compile-time `extends Value`
 * check, so a plain-JSON literal that happens to use `tag`/`value`/`filters` as
 * keys with an unrecognized tag is not falsely rejected. Mirrors the `isValue`
 * predicate in `responses/response.ts`.
 *
 * Exported so `coerceObj` (the HTTP-request family's object field) can detect a
 * record-of-values with the *same* check `c.obj` rejects on — keeping the
 * "encode as object-of-values" runtime branch in lockstep with the `c.obj`
 * strict-constant guard (issues #74/#75).
 */
export function isTaggedValue(x: unknown): x is Value {
  return (
    // A trigger field accessor (`t.new`) is a *callable* Value — a function
    // carrying the `{value,tag,filters}` props — so `typeof` is "function", not
    // "object". Accept both, or a bare `t.new` slips past this check, falls
    // through coerceObj's record path, and trips the #42 c.obj guard (issue #78).
    (typeof x === "object" || typeof x === "function") &&
    x !== null &&
    "value" in x &&
    "filters" in x &&
    Array.isArray((x as { filters?: unknown }).filters) &&
    (TAGS as readonly string[]).includes((x as { tag?: unknown }).tag as string)
  );
}

/**
 * Throw if a tagged {@link Value} is nested anywhere in a `c.obj`/`c.array`
 * argument (issue #42). The compile-time {@link RejectValues} type is the first
 * line of defense; this guard catches JS callers and `any`-typed values that
 * erase the type, failing loudly at construction instead of 500ing at runtime.
 */
function assertPlainJson(x: unknown): void {
  if (isTaggedValue(x)) throw new Error(REJECT_TAGGED_VALUE);
  if (Array.isArray(x)) {
    for (const el of x) assertPlainJson(el);
  } else if (typeof x === "object" && x !== null) {
    for (const v of Object.values(x)) assertPlainJson(v);
  }
}

function val(value: string, tag: Tag, filters: FilterXdo[] = []): Value {
  return { value, tag, filters };
}

/** A JSON object (not an array, not null) — the shape that takes `set` filters. */
function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Is this key spellable as a BARE `set` path segment — an identifier the
 * engine's path reader takes as a literal key and nothing else?
 *
 * Anything outside `[A-Za-z_][A-Za-z0-9_]*` gets the bracket form, because the
 * reader splits on `.` and `[`: `"a.b"` bare would nest (`{a:{b:…}}`) where the
 * literal key must stay flat. Digits are excluded because a numeric segment is
 * an INDEX to that reader, not because the bracket form changes that — see the
 * numeric-key note on {@link c.obj}.
 */
const BARE_SET_PATH = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A `set` path segment for one object key — bare when it can be, otherwise the
 * engine's own bracket-and-quote escape, `["key"]`, which makes a key holding
 * any character spellable. Backslash is escaped BEFORE the quote so a key
 * ending in one cannot escape the closing quote and unterminate the segment.
 * {@link parseSetPath} in the codegen decoder is the exact inverse.
 */
function setPath(key: string): string {
  if (BARE_SET_PATH.test(key)) return key;
  return `["${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

/**
 * Encode one member of a `c.obj` record as the `set` filter's value argument.
 * Nested records recurse (nested `{}`-plus-`set`, exactly what the editor
 * writes); arrays stay a JSON `const:array` — that form survives the engine's
 * tag reader intact, braces and all, because they sit inside the brackets.
 *
 * Members a JSON encoder would not carry are matched to what the old
 * JSON-string form stored, so this is a change of FORM only: a non-finite
 * number becomes null exactly as `JSON.stringify` writes it (an engine that
 * read `"NaN"` as a decimal would get a number it cannot parse). An `undefined`
 * member is dropped one level up, in {@link objSetFilters}.
 */
function objMember(m: unknown): Value {
  if (isPlainRecord(m)) return val("{}", "const:obj", objSetFilters(m));
  if (Array.isArray(m)) return val(JSON.stringify(m), "const:array");
  if (m === null) return val("null", "const:null");
  if (typeof m === "boolean") return val(m ? "true" : "false", "const:bool");
  if (typeof m === "number") {
    if (!Number.isFinite(m)) return val("null", "const:null");
    // A magnitude past the safe-integer range only stringifies in exponent form
    // ("1e+21"), which is not an integer literal — carry it as a decimal, the
    // tag whose stored form is a string in the first place.
    return Number.isInteger(m) && Number.isSafeInteger(m)
      ? val(String(m), "const:int")
      : val(String(m), "const:decimal");
  }
  return val(String(m), "const");
}

/**
 * A populated object constant as one `set` filter per key over an empty `{}`
 * base — the ONLY populated form the engine can read back (issue #248).
 *
 * A statement's stored `{value, tag, filters}` is flattened to a single piped
 * string (`{}|set(!const "a",!const:int 1)`) before it is evaluated, and the
 * reader that splits that string back apart ends the value at the first
 * unquoted `}` or `,` outside brackets. So a populated JSON string —
 * `{"a":1}` — arrives truncated to `{"a":1`, fails to JSON-decode, and the
 * request dies with the engine's generic `ERROR_FATAL "Unable to decode."`,
 * which names neither the statement nor the value. `{}` alone is special-cased
 * by that reader, and each key's data rides inside a `set(...)` argument where
 * quoting protects it — which is why this form works and why the editor has
 * only ever written this one.
 */
function objSetFilters(o: Record<string, unknown>): FilterXdo[] {
  return (
    Object.entries(o)
      // An `undefined` member is not a null — `JSON.stringify` DROPS such a key,
      // and a key present as null is a different value at runtime (an `exists`
      // check flips). Dropping it keeps this a change of form only.
      .filter(([, m]) => m !== undefined)
      .map(([key, m]) => filter("set", val(setPath(key), "const"), objMember(m)))
  );
}

/** PCRE modifiers that also exist (and mean the same thing) as JS RegExp flags.
 * A `RegExp`'s `g`/`y`/`d` are JS-only — passing them to PHP `preg_*` raises
 * "Unknown modifier", so they are dropped when deriving flags from a RegExp. */
const PCRE_JS_FLAGS = "imsxu";

/** Escape any interior forward slash so a `/…/`-delimited literal stays valid
 * (`\d/\d` → `\d\/\d`). Backslash escapes are skipped so `\/` is never doubled. */
function escapeRegexSlashes(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      out += ch + (body[i + 1] ?? "");
      i++;
      continue;
    }
    out += ch === "/" ? "\\/" : ch;
  }
  return out;
}

/**
 * Emulate PHP's delimiter scan to decide whether a const string is a *valid*
 * PCRE literal (`/…/flags`, `~…~i`, `(…)`, …) — the check behind the {@link
 * withFilters} guard. The delimiter is the first char (must be non-alphanumeric,
 * non-backslash, non-whitespace); the pattern ends at the next *unescaped*
 * closing delimiter, after which only flag letters may follow. A bare JS-style
 * body (`^[^@\s]+$`, `[a-z]+`, `\d{2}`) fails this — exactly the input PHP rejects,
 * so the guard fires on the same strings the engine would silently no-match on.
 */
function isValidPcreLiteral(s: string): boolean {
  if (s.length < 2) return false;
  const d = s[0]!;
  if (/[a-zA-Z0-9\\\s]/.test(d)) return false;
  const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[d] ?? d;
  let i = 1;
  for (; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === close) break;
  }
  if (i >= s.length) return false;
  return /^[a-zA-Z]*$/.test(s.slice(i + 1));
}

/** The pattern-piped regex filters: the value they filter is the regex PATTERN,
 * so a bare (undelimited) const there is the {@link withFilters} footgun. Excludes
 * `regex_quote` (whose piped value is raw text to be escaped, not a pattern). */
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
 * Tags {@link c.blank} can spell — the constant tags with no exact blank form of
 * their own.
 *
 * Derived by exclusion from {@link TAGS} rather than listed, so a constant tag
 * added to the catalog is blank-spellable without a second edit here. The two
 * carve-outs are the tags that already round-trip a blank exactly: `const` via
 * `c.text("")`, and `const:obj` via `c.obj(null)`.
 *
 * Reference tags are excluded by construction: a blank `var`/`input`/`col` is an
 * unbound reference, not an empty value, and the two want different fixes.
 */
export type BlankTag = Exclude<Extract<Tag, `const${string}`>, "const" | "const:obj">;

/** Constant constructors. Values always serialize as strings (per fixture). */
export const c = {
  /**
   * Plain string constant → `tag:"const"`.
   *
   * `null` is accepted alongside a string because the engine stores both: 47
   * values in the sweep are a bare `const` holding `null` rather than `""`,
   * mostly ignored statement-input entries the engine never reads. They are
   * distinct bytes — `normalize` keeps them apart, unlike the `const:obj` blanks
   * it does canonicalize — so a pull has to be able to spell the null form, and
   * `c.text(null)` did not type-check.
   *
   * Write `c.text("")` for an empty string. The null form is here so a pulled
   * workspace round-trips, not to be authored.
   */
  text(s: string | null): Value {
    return val(s as string, "const");
  },
  /** Integer constant → `tag:"const:int"`, value stringified (e.g. `"123"`). */
  int(n: number): Value {
    return val(String(n), "const:int");
  },
  /**
   * Decimal constant → `tag:"const:decimal"`.
   *
   * Pass a **string** to preserve a stored spelling a number literal cannot
   * reproduce — `c.decimal("10.00")` keeps its trailing zeros, where
   * `c.decimal(10)` writes `"10"`. The engine stores decimals as strings either
   * way, so this is exactness rather than a workaround; prefer the number form
   * whenever it reproduces the value you want.
   */
  decimal(n: number | string): Value {
    return val(String(n), "const:decimal");
  },
  /**
   * The editor's **unconfigured value box** — a value cell added and never
   * filled in, stored as `{value: "", tag}`.
   *
   * This is not a zero, an empty string, or an empty collection. The engine
   * reads `""` and `"0"` differently, so `c.blank("const:int")` and `c.int(0)`
   * are different stored values and the SDK will not canonicalize one into the
   * other. It exists because 13 real values in the survey corpus are in this
   * state and had no authoring form, so a pull emitted them as annotated
   * literals with a warning attached — describing a workspace that was fine.
   *
   * Constant tags only. A blank `var` or `input` is an unbound REFERENCE, which
   * is a different defect with a different fix, and is deliberately not
   * spellable here. `const` and `const:obj` are excluded too: they already have
   * exact blank forms in `c.text("")` and `c.obj(null)`, and a second spelling
   * for the same bytes is how two constructors start disagreeing.
   */
  blank(tag: BlankTag): Value {
    return val("", tag);
  },
  /** Boolean constant → `"true"`/`"false"` with `tag:"const:bool"`. */
  bool(b: boolean): Value {
    return val(b ? "true" : "false", "const:bool");
  },
  /** Null constant → `tag:"const:null"`, value `"null"` (per engine fixture). */
  null(): Value {
    return val("null", "const:null");
  },
  /**
   * Build a **regex pattern value** for the pattern-piped regex filters
   * (`fl.regex_test`/`regex_match`/`regex_replace`/…). Xano runs PHP `preg_*`, so
   * the pattern MUST be delimiter-wrapped — a bare `c.text("^…$")` is an invalid
   * PCRE and the filter then matches *nothing* for every input, so a precondition
   * built on it silently rejects all values (issue #128). This wraps the raw
   * pattern in `/…/`, escapes any interior `/`, and appends `flags`, so the result
   * is always valid; `withFilters` rejects a bare `c.text` pattern and points here.
   *
   * Pass a JS `RegExp` (source + flags used directly, minus JS-only `g`/`y`/`d`):
   * `c.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/i)`, or a raw body + optional PCRE flags:
   * `c.regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "i")`. The pattern is the piped
   * value; the filter's `subject` arg is the text tested against it.
   */
  regex(pattern: string | RegExp, flags?: string): Value {
    const body = typeof pattern === "string" ? pattern : pattern.source;
    const raw =
      flags ??
      (typeof pattern === "string"
        ? ""
        : [...pattern.flags].filter((ch) => PCRE_JS_FLAGS.includes(ch)).join(""));
    if (!/^[a-zA-Z]*$/.test(raw)) {
      throw new Error(`c.regex: flags must be letters (e.g. "i", "im"), got ${JSON.stringify(raw)}`);
    }
    return val(`/${escapeRegexSlashes(body)}/${raw}`, "const");
  },
  /**
   * Current time as an **epoch-milliseconds** value — the engine's native
   * `const:epochms` constant. Xano has no `$now` *setting*, so this lives on
   * `c.*` (a current-time literal) rather than {@link sys} (which emits
   * `setting("$…")` and would reference a dead `$now` var).
   *
   * Emits `{tag:"const:epochms", value:"now"}` — an UNFILTERED value, valid
   * inline as a `where`/`cmp` operand. It previously emitted the equivalent
   * `text("now") |to_epoch_ms` chain; both evaluate to the same epoch-ms number
   * on a live engine, and both persist verbatim, but the native tag is what the
   * editor writes and needs no filter to get there. Chain math onto it as usual:
   * `withFilters(c.now(), fl.epochms_add_ms(c.int(-maxAgeMs)))`. (issues #120,
   * #145)
   */
  now(): Value {
    return val("now", "const:epochms");
  },
  /**
   * Object constant → JSON-string value with `tag:"const:obj"`. Takes **plain
   * JSON literals only**: nesting a tagged value (`inp`/`ref`/`auth`/`c.*`) is a
   * compile error and throws at runtime — it would serialize as internal
   * representation the engine can't decode. For a computed/multi-key object
   * response use a record of values (`response: { key: value }`), not `c.obj`.
   * See issue #42.
   *
   * Called with no argument it is the **empty object**, `{}` — the same default
   * the editor gives a new object variable, and the only empty form current
   * editors write.
   *
   * Called with an explicit `null` it is the **blank** form (stored `value: ""`),
   * which the engine evaluates to `null` rather than `{}` — it JSON-decodes the
   * stored string, and decoding `""` yields null. That is a real difference in
   * what the statement sees, so the two are separate spellings rather than one
   * "empty object": `c.obj()` is `{}`, `c.obj(null)` is null.
   *
   * ⚠ **Prefer `c.obj()`.** The blank form is legacy — no current editor path
   * writes it — and it exists here so a pulled workspace round-trips to the
   * same bytes instead of being quietly re-pointed at `{}`.
   *
   * A **populated** object is stored the way the editor stores one: an empty
   * `{}` base carrying one `set` filter per key (issue #248). It is NOT a
   * populated JSON string — that form fails the request at runtime, see
   * {@link objSetFilters}.
   *
   * ⚠ **Zero-based numeric keys come back as a LIST**, not an object:
   * `c.obj({ "0": "a" })` evaluates to `["a"]`. That is the engine's data model
   * — a numeric key IS an index there, and the same object decoded from JSON
   * anywhere else behaves identically — not something this encoding introduces.
   * A non-zero-based numeric key (`{ "2": … }`) survives as a key. Live-verified.
   */
  obj<const T>(o?: (T & RejectValues<T>) | null): Value {
    // Explicit `null` is the blank form, and is NOT the same as no argument:
    // `c.obj()` writes `{}`. Checked before the `??` below, which would
    // otherwise fold the two together.
    if (o === null) return val("", "const:obj");
    const j = (o ?? {}) as unknown;
    assertPlainJson(j);
    // Only a RECORD takes the `{}`-plus-`set` form. An array (what `coerceObj`
    // routes here for a list-valued field) and any bare scalar keep the JSON
    // string: brackets and quotes shield those from the tag reader that
    // truncates a bare `}` — see {@link objSetFilters}.
    if (!isPlainRecord(j)) return val(JSON.stringify(j), "const:obj");
    return val("{}", "const:obj", objSetFilters(j));
  },
  /**
   * Array constant → JSON-string value with `tag:"const:array"`. Takes **plain
   * JSON literals only** — like {@link obj}, a nested tagged value is a compile
   * error and throws at runtime. See issue #42.
   */
  array<const T extends readonly unknown[]>(a: T & RejectValues<T>): Value {
    assertPlainJson(a);
    return val(JSON.stringify(a), "const:array");
  },
  /**
   * A **Xano Expression Engine** expression, passed through verbatim →
   * `tag:"const:expr2"`. The string IS the expression, exactly as it would be
   * typed into the expression editor:
   *
   *   c.expression('"Hello, " ~ $input.name')
   *   c.expression("$var.price * $var.qty")
   *   c.expression("{ id: $var.user.id, tier: $var.plan }")
   *
   * ⚠️ **THE STRING IS NOT VALIDATED.** SideStep does not parse it, does not
   * type-check it, and cannot tell a working expression from a typo — the whole
   * string is handed to the engine as-is. Nothing here participates in
   * `InferResponse`, so a var referenced inside it is invisible to the type
   * system, and a rename that updates every typed `ref()` will NOT update this.
   * A malformed expression surfaces at RUNTIME, and one that is merely wrong
   * (`$var.tota1`) surfaces as a wrong answer, not an error. Play at your own
   * risk until validation exists.
   *
   * Prefer the typed surfaces whenever they cover the case: `ref`/`inp`/`col`
   * for references, `withFilters(..., fl.*)` for transforms, {@link obj} for a
   * dynamic object (it BUILDS a checked expression for you). Reach for this only
   * for expression-engine syntax the typed surfaces cannot express — string
   * concatenation with `~`, inline arithmetic, conditionals.
   *
   * NOT the `expr()` condition builder. `expr(col("id"), "=", inp("id"))` builds
   * a comparison for a `where`; this builds a VALUE from raw expression source.
   */
  expression(source: string): Value {
    assertExpressionSource(source, "c.expression");
    return val(source, "const:expr2");
  },
  /**
   * The **older** expression form → `tag:"const:expr"`, kept because real
   * workspaces still hold values stored that way and codegen has to bring them
   * back as something readable. New code wants {@link expression}, which is what
   * the expression editor writes today.
   *
   * ⚠️ Unvalidated passthrough, exactly like {@link expression} — see the
   * warning there. This one additionally uses the older syntax generation, so an
   * expression copied out of the current editor may not mean the same thing
   * here.
   */
  expressionLegacy(source: string): Value {
    assertExpressionSource(source, "c.expressionLegacy");
    return val(source, "const:expr");
  },
};

/**
 * Guard the two raw-expression constructors.
 *
 * The type signature already says `string`, but the failure this catches is the
 * one the type system cannot: `c.expression` sits one keystroke from `expr()`,
 * the condition builder, and a caller reaching for the wrong one passes a
 * `Value` or a comparison. Silently stringifying that would ship `[object
 * Object]` into an expression the engine evaluates at runtime, so it throws
 * here, pointing at the surface that was actually wanted.
 */
function assertExpressionSource(source: string, fn: string): void {
  if (typeof source !== "string") {
    const tagged = isTaggedValue(source);
    throw new Error(
      `${fn}() takes the expression SOURCE as a string, got ${tagged ? "a Value" : typeof source}. ` +
        (tagged
          ? `To reference a value inside an expression, write its path into the string ` +
            `(e.g. ${fn}("$var.total * 2")). For a comparison in a where/condition use ` +
            `expr(left, op, right) or cmp(...), not ${fn}().`
          : `Pass expression-engine source, e.g. ${fn}('"Hi, " ~ $input.name').`),
    );
  }
  if (source === "") {
    throw new Error(
      `${fn}() was given an empty string, which the engine cannot evaluate. ` +
        `Pass expression source, or use c.text("") for an empty string constant.`,
    );
  }
}

/** Options for {@link ref}. */
export interface RefOptions {
  /**
   * Null-safe nested access (opt-in). A dotted `ref("owner.user_id")` normally
   * compiles to the raw var path `$owner.user_id`, which the engine resolves in
   * a single lookup — so when the base var `owner` is null (e.g. a `db.get` that
   * matched no row), it raises a runtime `ERROR_FATAL` "Unable to locate var"
   * (HTTP 500) instead of yielding null (issue #47).
   *
   * With `safe: true` the path compiles through the `get` filter
   * (`$owner|get:"user_id"`), which walks the remaining path and resolves to
   * null when the base is null — so an ownership/existence guard evaluates to
   * `false` cleanly rather than throwing. Has no effect on a plain, dot-free name
   * (a bare var already resolves to null without error).
   */
  safe?: boolean;
}

/**
 * Reference a **stack variable** — the `as:` output of an earlier statement:
 * `{tag:"var", value}`. e.g. `dbGet({ ..., as: "user" })` then `ref("user")`.
 *
 * Pass `{ safe: true }` to make a *nested* path null-safe: `ref("owner.user_id",
 * { safe: true })` resolves to null instead of 500ing when the base `owner` is
 * null (issue #47) — the intent-revealing opt-in for drilling into a `db.get`
 * result that may not exist.
 *
 * Picking a reference helper (these are easy to mix up):
 * - {@link ref} — a stack variable (`as:` output). **Not** a foreign key — that's
 *   the field constructor `f.tableRef`.
 * - {@link inp} — an endpoint/function `input`.
 * - {@link col} — a table column (in a `db.query` `where`/view comparison).
 * - {@link auth} — the authenticated caller (`auth("id")`).
 * - `c.*` — a literal constant (`c.int(1)`, `c.text("x")`).
 */
export function ref<const Name extends string>(name: Name, opts?: RefOptions): RefValue<Name> {
  const dot = name.indexOf(".");
  if (opts?.safe && dot !== -1) {
    // Compile `owner.user_id` → `$owner|get:"user_id"`: reference the base var
    // (which exists and may be null) and let the `get` filter walk the rest of
    // the path, resolving to null instead of raising when the base is null (#47).
    const base = name.slice(0, dot);
    const path = name.slice(dot + 1);
    return withFilters(val(base, "var"), filter("get", c.text(path), c.null())) as unknown as RefValue<Name>;
  }
  // `__ref` is a phantom (type-only) carrier — the runtime object is exactly the
  // plain `{value, tag, filters}` Value; the cast attaches the name to the type.
  return val(name, "var") as RefValue<Name>;
}

/** Reference a function/endpoint **input**: `{tag:"input", value}`. See {@link ref} for the full picker. */
export function inp(name: string): Value {
  return val(name, "input");
}

/**
 * Reference a table **column**: `{tag:"col", value}` (used in `db.query` `where` +
 * table views). See {@link ref} for the full picker. The return is branded
 * {@link ColValue} so it is a *compile error* to pass `col()` into a `db.edit`/
 * `db.add` `row` — where it would resolve to `null` at runtime (issue #32).
 */
export function col(name: string): ColValue {
  return val(name, "col") as ColValue;
}

/**
 * Reference the authenticated identity (`{tag:"auth", value}`). Pass a path to
 * drill into the auth record — `auth("id")` is the authenticated row id
 * (Xano's `$auth.id`); bare `auth()` is the whole record. Use it to bind the
 * caller into a row write on an authenticated endpoint (one whose `auth` names
 * an auth table), e.g.
 * `s.db.add({ table: post, row: { author_id: auth("id") } })`.
 */
export function auth(path = ""): Value {
  return val(path, "auth");
}

/**
 * The four fields the engine binds in a `s.try_catch` catch arm. Read straight
 * off the engine's own catch-variable map, which sets exactly these.
 */
export type CaughtField = "code" | "message" | "name" | "result";

/**
 * Read the caught error inside a {@link s.try_catch} **catch** arm
 * (`{tag:"trycatch", value}` — XanoScript's `$trycatch.*`).
 *
 * Only valid inside the catch arm; the engine binds these for that scope alone
 * and they read empty anywhere else. The four fields are all the engine sets:
 * - `name` — the error name/type (for a thrown error statement, its message)
 * - `message` — the human-readable message (`"Throw Error Statement"` for a throw)
 * - `code` — the mapped HTTP-ish error code
 * - `result` — the error payload, when one was attached
 *
 * e.g. `s.try_catch({ try: [...], catch: [s.debug_log(caught("message"))] })`.
 * Bare `caught()` is the whole error record.
 */
export function caught(path: CaughtField | "" = ""): Value {
  return val(path, "trycatch");
}

/**
 * Read a **workspace environment variable** — the ones set via `workspaceConfig({ env })`
 * or the workspace dashboard, e.g. `env("STRIPE_KEY")` → `$env.STRIPE_KEY`.
 *
 * Under the hood a workspace env var is a `{tag:"setting", value:"NAME"}` (the plain,
 * non-`$` name) — `$env.NAME` in XanoScript is sugar for that setting. This is the SAME
 * tag the built-in request/system vars use; those just carry a `$`-prefixed name
 * (`$env.$remote_ip`). So `env("remote_ip")` reads a *user* var literally named
 * `remote_ip` (usually unset → null), NOT the caller IP — use {@link sys} (`sys.remoteIp()`)
 * or {@link setting} with the exact `$`-prefixed name for the built-ins.
 *
 * (`$env.NAME` is a setting, not the raw `tag:"env"` form — which does not resolve
 * workspace vars — so this reads them as settings, matching the platform.)
 */
export function env(name: string): Value {
  return val(name, "setting");
}

/**
 * Reference a workspace setting by raw name (`{tag:"setting", value}`). The built-in
 * request/system variables are settings with a **`$`-prefixed** name — `setting("$remote_ip")`,
 * `setting("$datasource")`, etc. Prefer the typed {@link sys} accessors, which spell the
 * names for you and avoid the `$`-prefix footgun; drop to `setting()` only for a name `sys`
 * doesn't cover.
 */
export function setting(name: string): Value {
  return val(name, "setting");
}

/**
 * Built-in **system / request-context variables**. In XanoScript these are written
 * `$env.$remote_ip`, `$env.$datasource`, … — note the second `$`: they are *settings*
 * (`{tag:"setting", value:"$remote_ip"}`), distinct from the user-defined env vars that
 * {@link env} reaches. Reaching for `env("remote_ip")` silently reads the wrong thing;
 * these accessors emit the correct `setting("$…")` form so you never type the `$` prefix.
 *
 * The one that matters most: on a **public** endpoint `auth("id")` is null (every caller
 * collapses into one bucket), so key a rate limit off {@link sys.remoteIp} instead —
 * `withFilters(c.text("rl:apply:"), fl.concat(sys.remoteIp()))`.
 *
 * Mirrors the full workspace "environment" panel; every accessor returns a {@link Value}.
 */
export const sys = {
  /** Client IP address (`$remote_ip`, text). Best public-endpoint rate-limit key. */
  remoteIp: (): Value => val("$remote_ip", "setting"),
  /** HTTP method of the request — `GET`, `POST`, … (`$request_method`, text). */
  requestMethod: (): Value => val("$request_method", "setting"),
  /** Full request URI/path (`$request_uri`, text). */
  requestUri: (): Value => val("$request_uri", "setting"),
  /** Raw query-string portion of the URL (`$request_querystring`, text). */
  requestQueryString: (): Value => val("$request_querystring", "setting"),
  /** Request headers as an object/map (`$http_headers`, object). */
  httpHeaders: (): Value => val("$http_headers", "setting"),
  /** The caller's `Authorization` bearer token, if present (`$request_auth_token`, text). */
  requestAuthToken: (): Value => val("$request_auth_token", "setting"),
  /** API base URL for the request (`$api_baseurl`, text). */
  apiBaseUrl: (): Value => val("$api_baseurl", "setting"),
  /** Active data source name — e.g. `live` or a branch source (`$datasource`, text). */
  datasource: (): Value => val("$datasource", "setting"),
  /** Active branch name (`$branch`, text). */
  branch: (): Value => val("$branch", "setting"),
  /** Tenant identifier for multi-tenant instances (`$tenant`, text). */
  tenant: (): Value => val("$tenant", "setting"),
  /** Current release number (`$release`, int). */
  release: (): Value => val("$release", "setting"),
  /** Platform identifier (`$platform`, int). */
  platform: (): Value => val("$platform", "setting"),
  /** `true` when the request is running under the debugger (`$debugger`, bool). */
  isDebugger: (): Value => val("$debugger", "setting"),
};

/**
 * Reference a column of the **parent statement's output row** (`{tag:"output",
 * value}`) — the `$output.<col>` reference an addon input binds to. Only
 * meaningful inside an addon spec's `input` map (see `s.db.query`'s `addon`
 * arg), where the engine resolves it against each row the parent query returns,
 * e.g. `addon: [{ addon: transactions, as: "items._txns",
 * input: { user_id: out("id") } }]`.
 */
export function out(name: string): Value {
  return val(name, "output");
}

/** Build a `mvp_filter` chain entry: `{name, disabled:false, arg}`. */
export function filter(name: string, ...args: (Value | undefined)[]): FilterXdo {
  // A HOLE — an omitted argument with a supplied one after it — is the whole of
  // issue #221's second half. Dropping it (below) would slide every later
  // argument one slot forward, so the code lands in the initial-value slot and
  // the engine refuses the call, or worse, silently reads the wrong thing.
  // Omission is only ever meaningful from the END.
  const last = args.reduce((acc, a, i) => (a !== undefined ? i : acc), -1);
  const hole = args.slice(0, last).findIndex((a) => a === undefined);
  if (hole !== -1) {
    throw new Error(
      `Filter \`${name}\`: argument ${hole + 1} is omitted but argument ${last + 1} is supplied. ` +
        `Filter arguments are positional, so an omitted one in the middle would shift every argument after it ` +
        `into the wrong slot. Pass a value for argument ${hole + 1}, or use the named form ` +
        `— \`fl.${name}({ … })\` — which cannot mis-slot. (issue #221)`,
    );
  }
  // A lambda filter's body is checked HERE — the one choke point every spelling
  // passes through, `lam.*` or not (issue #221). It only fires where the body is
  // an inspectable constant.
  assertLambdaFilterArgs(name, args);
  // Drop omitted trailing args. Typed filter factories (fl.*) declare their
  // named params positionally, so calling one with fewer args (e.g. `fl.trim()`)
  // passes `undefined` here — without this it would serialize as a stray `null`.
  return { name, disabled: false, arg: args.filter((a): a is Value => a !== undefined) };
}

/**
 * Attach a filter chain to a value, returning a new value. Pass filters spread
 * (the canonical form, `withFilters(v, fl.trim(), fl.lower())`); the array form
 * (`withFilters(v, [fl.trim(), fl.lower()])`) is also accepted — both are flattened.
 */
export function withFilters<V extends Value>(
  value: V,
  ...filters: (FilterXdo | FilterXdo[])[]
): FilteredValue & (V extends ColValue ? { readonly __col: true } : unknown) {
  const added = filters.flat();
  // Guard the pattern-piped regex footgun (issue #128): when a regex filter is
  // the first thing applied to a bare `const` value, that value IS the pattern —
  // and an undelimited PCRE silently matches nothing for every input (a
  // precondition on it rejects all values, valid ones included). Only fire when
  // the base is an unfiltered const literal we can actually inspect; a ref/inp
  // pattern or a mid-chain value is left alone. Point straight at `c.regex`.
  const first = added[0];
  if (
    first &&
    REGEX_PATTERN_FILTERS.has(first.name) &&
    value.filters.length === 0 &&
    value.tag === "const" &&
    !isValidPcreLiteral(value.value)
  ) {
    throw new Error(
      `Regex filter \`${first.name}\` is pattern-piped: the value it filters is the ` +
        `regex PATTERN, which PHP \`preg_*\` requires to be delimiter-wrapped. ` +
        `${JSON.stringify(value.value)} is a bare pattern, so the engine matches nothing ` +
        `for every input (a precondition on it silently rejects all values). Build it with ` +
        `c.regex(${JSON.stringify(value.value)}) instead of c.text(...). (issue #128)`,
    );
  }
  // `__filtered` is a phantom carrier — the runtime object is the plain
  // `{value, tag, filters}` Value; the cast marks the type as filter-reshaped so
  // `InferResponse` degrades it to `unknown`. A `col()`-derived chain keeps the
  // `__col` brand so `withFilters(col("x"), fl.add(...))` is rejected in a `row`
  // just like a bare `col()` (issue #32) — the wrapped form is the actual footgun.
  return { ...value, filters: [...value.filters, ...added] } as FilteredValue &
    (V extends ColValue ? { readonly __col: true } : unknown);
}
