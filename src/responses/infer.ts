/**
 * `InferResponse<Q>` (issue #5) — the response type for a query or function def,
 * the read-side counterpart of `InferInput`. Closes the round trip: rename or
 * retype what an endpoint returns and every consumer that types a response
 * against `InferResponse` lights up at compile time.
 *
 * ```ts
 * const listLinks = query({ verb: "GET", apiGroup: links, name: "list_links",
 *   stack: [s.db.query({ table: link, as: "rows" })], response: ref("rows"),
 *   responseShape: [] as InferRow<typeof link>[] });
 *
 * type Links = InferResponse<typeof listLinks>;   // InferRow<typeof link>[]
 * const res = await fetch(BASE + listLinks.getPath());
 * const links: Links = await res.json();          // typed end to end
 * ```
 *
 * **Hybrid resolution** (mirrors how the Xano engine derives its OpenAPI response
 * schema — a static walk that degrades to `json` where truth isn't statically
 * knowable):
 *   1. A declared `responseShape` on the def always wins (the override).
 *   2. Otherwise the shape is auto-derived from `response` + `stack`
 *      ({@link DeriveResponse}) — object-literal keys (U2) and a single variable
 *      traced to a typed `db.get`/`db.query` (U5). A dotted `ref("var.field")`
 *      traces the base variable, then indexes the subpath into its shape (#93).
 *   3. Anything the walk can't resolve (filters, lambdas, control-flow vars,
 *      `set_var`, function-produced vars, streams) resolves to `unknown`, which
 *      the author narrows or overrides via `responseShape`.
 */
import type { Value, RefValue, FilteredValue } from "../values/value.js";
import type { AsShapeBrand } from "../statements/statement.js";
import type { Prettify } from "../fields/value-types.js";

/**
 * The author-declared response shape, read from a def's `responseShape` field
 * (captured by `query()`/`defineFunction()`), or `never` when undeclared.
 *
 * Read structurally rather than off the `Res` type argument: an undeclared def
 * carries `responseShape?: never`, whose optional-collapsed field type is
 * `undefined` — the `[R] extends [undefined]` gate maps that to `never` (→ route
 * to derivation). A declared shape's field type is `T | undefined`; stripping the
 * optional `undefined` with `Exclude` recovers `T` **while preserving a
 * deliberate `| null`** (e.g. `InferRow<...> | null` stays nullable).
 */
type DeclaredResponse<Q> = Q extends { responseShape?: infer R }
  ? [R] extends [undefined]
    ? never
    : Exclude<R, undefined>
  : never;

/**
 * Search a branded stack tuple `S` for the read statement that bound the
 * variable `Name` (its phantom `__as`), returning that statement's `__shape`.
 * Mirrors the engine's `findVarSchema`: a one-hop, top-level match. Statements
 * without the `__as`/`__shape` brand (`set_var`, control flow, function calls)
 * are skipped, so a ref into one of those falls through to `unknown` — exactly
 * where the engine falls back to `json`. A widened (non-tuple) stack matches no
 * head and yields `unknown` too.
 */
type TraceBinding<Name extends string, S> = S extends readonly [infer Head, ...infer Tail]
  ? Head extends AsShapeBrand<infer As, infer Shape>
    ? As extends Name
      ? Name extends As
        ? Shape
        : TraceBinding<Name, Tail>
      : TraceBinding<Name, Tail>
    : TraceBinding<Name, Tail>
  : unknown;

/**
 * Walk a dotted subpath `Path` into an already-traced binding `Shape`, one
 * segment at a time: `IndexShape<AgentRunResult<string>, "result">` → `string`.
 *
 * **Null-propagating** (#105): when the base is nullable (e.g. a `db.get` row,
 * `Row | null`), the null flows *through* the projection rather than erasing it —
 * `IndexShape<Row | null, "slug">` → `string | null`, mirroring the engine's
 * runtime where `$row.slug` on a missed (null) row is itself null. Without this,
 * `keyof (Row | null)` narrows to `never` and every dotted ref into a nullable
 * base would bottom out at `unknown`, silently dropping the #93 projection.
 *
 * A segment that genuinely isn't a key of the (non-null) shape — including a
 * shape that is already `unknown` (whose `keyof` is `never`) — still bottoms out
 * at `unknown`, the same honest floor as an untraceable whole ref.
 */
type IndexShape<Shape, Path extends string> = unknown extends Shape
  ? IndexStep<Shape, Path>
  : null extends Shape
    ? IndexShape<Exclude<Shape, null>, Path> | null
    : undefined extends Shape
      ? IndexShape<Exclude<Shape, undefined>, Path> | undefined
      : IndexStep<Shape, Path>;

/**
 * One non-null indexing step for {@link IndexShape}: split the head segment off
 * `Path` and project it into `Shape`, recursing (back through the null-aware
 * {@link IndexShape}) for the tail. A segment that isn't a key bottoms out at
 * `unknown`. Kept separate so the `unknown extends Shape` guard in `IndexShape`
 * (true for exactly `unknown`/`any` — the bases where null-distribution can't
 * terminate) routes straight here without looping.
 */
type IndexStep<Shape, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Shape
    ? IndexShape<Shape[Head], Rest>
    : unknown
  : Path extends keyof Shape
    ? Shape[Path]
    : unknown;

/**
 * Resolve a `ref` name against the branded stack `S`. A **dotted** name projects
 * a subpath (#93): the head names the bound variable (traced via
 * {@link TraceBinding}) and the tail indexes into that variable's shape (via
 * {@link IndexShape}), so `ref("generated.result")` types to the completion, not
 * `unknown`. A bare name traces the whole binding. Stack-variable names are
 * identifiers (no dots), so the first `.` always splits the variable from the
 * subpath — matching how the engine resolves `$generated.result`.
 */
type TraceVar<Name extends string, S> = Name extends `${infer Base}.${infer Path}`
  ? IndexShape<TraceBinding<Base, S>, Path>
  : TraceBinding<Name, S>;

/**
 * Resolve one response {@link Value} to its type against the branded stack `S`.
 * A filtered value degrades to `unknown` first (a filter can reshape it with no
 * static signal); otherwise a branded `ref` traces to the statement that
 * produced it ({@link TraceVar}); anything else (a non-ref value, an untraceable
 * ref) is `unknown` — the honest floor.
 */
type ResolveValue<V, S> = V extends FilteredValue
  ? unknown
  : V extends RefValue<infer Name>
    ? TraceVar<Name, S>
    : unknown;

/**
 * Best-effort automatic derivation of a response shape from the def's `response`
 * field and branded `stack`. Mirrors the Xano engine's static walk:
 *   - a record response (object literal) → an object with **those keys** (each
 *     value resolved individually); keys are known regardless of traceability;
 *   - a single {@link Value} response → resolve it against the stack;
 *   - no response / an unresolvable shape → `unknown`.
 * Kept separate from {@link DeclaredResponse} so the user override always wins.
 */
export type DeriveResponse<Q> = Q extends { response?: infer Resp; stack?: infer S }
  ? [Resp] extends [undefined]
    ? unknown
    : Resp extends Value
      ? ResolveValue<Resp, S>
      : Resp extends Record<string, Value>
        ? Prettify<{ -readonly [K in keyof Resp]: ResolveValue<Resp[K], S> }>
        : unknown
  : unknown;

/**
 * Recover a query/function's response type. A declared `responseShape` wins;
 * otherwise fall back to automatic derivation (which itself bottoms out at
 * `unknown` for anything the static walk can't resolve).
 */
export type InferResponse<Q> = [DeclaredResponse<Q>] extends [never]
  ? DeriveResponse<Q>
  : DeclaredResponse<Q>;
