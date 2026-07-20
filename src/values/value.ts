/**
 * The shared tagged-value primitive (KTD-2). Every place a function references
 * data — input bindings, statement context, response — uses this `{value, tag,
 * filters}` shape. Built and tested once here, reused everywhere.
 */
import type { FilterXdo, TaggedValue, Tag } from "../types/xdo.js";

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
  /** Object constant → JSON-string value with `tag:"const:obj"`. */
  obj(o: Record<string, unknown>): Value {
    return val(JSON.stringify(o), "const:obj");
  },
  /** Array constant → JSON-string value with `tag:"const:array"`. */
  array(a: unknown[]): Value {
    return val(JSON.stringify(a), "const:array");
  },
};

/**
 * Reference a **stack variable** — the `as:` output of an earlier statement:
 * `{tag:"var", value}`. e.g. `dbGet({ ..., as: "user" })` then `ref("user")`.
 *
 * Picking a reference helper (these are easy to mix up):
 * - {@link ref} — a stack variable (`as:` output). **Not** a foreign key — that's
 *   the field constructor `f.tableRef`.
 * - {@link inp} — an endpoint/function `input`.
 * - {@link col} — a table column (in a `db.query` `where`/view comparison).
 * - {@link auth} — the authenticated caller (`auth("id")`).
 * - `c.*` — a literal constant (`c.int(1)`, `c.text("x")`).
 */
export function ref<const Name extends string>(name: Name): RefValue<Name> {
  // `__ref` is a phantom (type-only) carrier — the runtime object is exactly the
  // plain `{value, tag, filters}` Value; the cast attaches the name to the type.
  return val(name, "var") as RefValue<Name>;
}

/** Reference a function/endpoint **input**: `{tag:"input", value}`. See {@link ref} for the full picker. */
export function inp(name: string): Value {
  return val(name, "input");
}

/** Reference a table **column**: `{tag:"col", value}` (used in `db.query` `where` + table views). See {@link ref} for the full picker. */
export function col(name: string): Value {
  return val(name, "col");
}

/**
 * Reference the authenticated identity (`{tag:"auth", value}`). Pass a path to
 * drill into the auth record — `auth("id")` is the authenticated row id
 * (Xano's `$auth.id`); bare `auth()` is the whole record. Use it to bind the
 * caller into a row write on an `auth: true` endpoint, e.g.
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
 * Attach a filter chain to a value, returning a new value. Accepts filters
 * either spread (`withFilters(v, fl.trim(), fl.lower())`) or as an array
 * (`withFilters(v, [fl.trim(), fl.lower()])`) — both are flattened.
 */
export function withFilters(value: Value, ...filters: (FilterXdo | FilterXdo[])[]): FilteredValue {
  // `__filtered` is a phantom carrier — the runtime object is the plain
  // `{value, tag, filters}` Value; the cast marks the type as filter-reshaped so
  // `InferResponse` degrades it to `unknown`.
  return { ...value, filters: [...value.filters, ...filters.flat()] } as FilteredValue;
}
