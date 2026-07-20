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
 */
function isTaggedValue(x: unknown): boolean {
  return (
    typeof x === "object" &&
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
};

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

/** Reference an environment variable (`{tag:"env", value}`), e.g. `env("STRIPE_KEY")`. */
export function env(name: string): Value {
  return val(name, "env");
}

/** Reference a workspace setting (`{tag:"setting", value}`). */
export function setting(name: string): Value {
  return val(name, "setting");
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
  // `__filtered` is a phantom carrier — the runtime object is the plain
  // `{value, tag, filters}` Value; the cast marks the type as filter-reshaped so
  // `InferResponse` degrades it to `unknown`. A `col()`-derived chain keeps the
  // `__col` brand so `withFilters(col("x"), fl.add(...))` is rejected in a `row`
  // just like a bare `col()` (issue #32) — the wrapped form is the actual footgun.
  return { ...value, filters: [...value.filters, ...filters.flat()] } as FilteredValue &
    (V extends ColValue ? { readonly __col: true } : unknown);
}
