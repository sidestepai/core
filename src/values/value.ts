/**
 * The shared tagged-value primitive (KTD-2). Every place a function references
 * data — input bindings, statement context, response — uses this `{value, tag,
 * filters}` shape. Built and tested once here, reused everywhere.
 */
import type { FilterXdo, TaggedValue, Tag } from "../types/xdo.js";
import { TAGS } from "../types/xdo.js";

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

/** Constant constructors. Values always serialize as strings (per fixture). */
export const c = {
  /** Plain string constant → `tag:"const"`. */
  text(s: string): Value {
    return val(s, "const");
  },
  /** Integer constant → `tag:"const:int"`, value stringified (e.g. `"123"`). */
  int(n: number): Value {
    return val(String(n), "const:int");
  },
  /** Decimal constant → `tag:"const:decimal"`. */
  decimal(n: number): Value {
    return val(String(n), "const:decimal");
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
   */
  obj<const T>(o: T & RejectValues<T>): Value {
    assertPlainJson(o);
    return val(JSON.stringify(o), "const:obj");
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
