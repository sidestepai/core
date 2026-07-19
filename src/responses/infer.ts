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
 *      traced to a typed `db.get`/`db.query` (U5).
 *   3. Anything the walk can't resolve (filters, lambdas, control-flow vars,
 *      `set_var`, function-produced vars, streams) resolves to `unknown`, which
 *      the author narrows or overrides via `responseShape`.
 */
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
 * Best-effort automatic derivation of a response shape from the def's `response`
 * field and `stack`. A stub (`unknown`) here; extended in U2 (object-literal
 * keys) and U5 (single-variable trace against the branded stack). Kept separate
 * from {@link DeclaredResponse} so the user override always takes precedence.
 */
export type DeriveResponse<_Q> = unknown;

/**
 * Recover a query/function's response type. A declared `responseShape` wins;
 * otherwise fall back to automatic derivation (which itself bottoms out at
 * `unknown` for anything the static walk can't resolve).
 */
export type InferResponse<Q> = [DeclaredResponse<Q>] extends [never]
  ? DeriveResponse<Q>
  : DeclaredResponse<Q>;
