/**
 * Value-type algebra for the typed descriptor layer (U1/U2).
 *
 * Input and column constructors (`input.*`, `f.*`) return a runtime descriptor
 * of exactly `{ type, options }`. This module adds a **phantom brand** to those
 * return types that carries, at the TYPE LEVEL only, the field's value type `V`
 * and the literal options object `O` the caller passed. The brand props are
 * optional and never assigned at runtime, so the emitted object is unchanged and
 * every branded descriptor stays structurally assignable to the un-branded
 * `FieldDescriptor` / `InputDescriptor` — existing consumers are unaffected.
 *
 * `InferInput` (see `../inputs/infer.ts`) reads these brands to turn a query's
 * declared `input` map into the request-payload TS type. The same algebra powers
 * nested-object inference, since object `children` are built from `f.*`.
 */

/**
 * Opaque runtime value of a file input/column. The request payload carries a
 * resource reference (path/metadata), not the raw bytes — model it structurally
 * rather than as `unknown` so a consumer at least sees an object shape.
 */
export interface XanoFileRef {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  meta?: unknown;
}

/**
 * Opaque runtime value of a raw file **upload** (`input.file()`).
 *
 * Distinct from {@link XanoFileRef}, and the distinction matters: this is the
 * bytes as they arrive on the request (multipart, base64, or a fetched URI). It
 * is not yet stored anywhere and cannot be written to a file column. Pass it to
 * a `s.storage.create_*` statement (`create_image`, `create_attachment`, …) to
 * store it and get back the {@link XanoFileRef} a column holds.
 */
export interface XanoFileUpload {
  readonly __fileUpload?: never;
}

/** Opaque runtime value of a geo input/column (a GeoJSON-shaped object). */
export interface XanoGeoJson {
  type: string;
  coordinates: unknown;
}

/**
 * Phantom brand intersected onto a descriptor's return type. `V` is the field's
 * base value type; `O` is the literal options object captured via a `const` type
 * parameter at the call site. Both props are optional and never present at
 * runtime.
 */
export interface TypeBrand<V, O> {
  readonly __value?: V;
  readonly __opts?: O;
}

/** The base value type carried by a branded descriptor `D` (before array/nullable). */
export type BrandValue<D> = D extends TypeBrand<infer V, unknown> ? V : unknown;

/** The literal options object captured on a branded descriptor `D`. */
export type BrandOpts<D> = D extends TypeBrand<unknown, infer O> ? O : object;

type ApplyArray<T, O> = O extends { array: true } ? T[] : T;
type ApplyNullable<T, O> = O extends { nullable: true } ? T | null : T;

/**
 * The full value type of a single branded descriptor `D`: its base value with
 * `array` and `nullable` applied. (Optionality of the *key* is a map-level
 * concern handled by {@link FromFieldMap}.)
 */
export type ValueOf<D> = ApplyNullable<ApplyArray<BrandValue<D>, BrandOpts<D>>, BrandOpts<D>>;

/** Keys whose descriptor options declare `required: true`. */
type RequiredKeys<M> = {
  [K in keyof M]: BrandOpts<M[K]> extends { required: true } ? K : never;
}[keyof M];

/** Keys without `required: true` — optional in the produced payload type. */
type OptionalKeys<M> = Exclude<keyof M, RequiredKeys<M>>;

/**
 * Turn a named map of branded descriptors into an object type: required inputs
 * become required keys, everything else becomes an optional (`?`) key. Used both
 * for a query's top-level `input` map and for nested `object` children.
 */
export type FromFieldMap<M> = Prettify<
  { [K in RequiredKeys<M>]: ValueOf<M[K]> } & { [K in OptionalKeys<M>]?: ValueOf<M[K]> }
>;

/**
 * Turn a named map of branded descriptors into a **row** type — the read shape
 * of a table. Unlike {@link FromFieldMap} (a request payload, where `required`
 * gates key optionality), every declared column is present on a returned row, so
 * all keys are required here; `nullable`/`array` still apply via {@link ValueOf}.
 * Powers `InferRow<typeof table>` (see `../kinds/table.ts`).
 */
export type RowFromFieldMap<M> = Prettify<{ [K in keyof M]: ValueOf<M[K]> }>;

/** Flatten an intersection into a single object literal for readable hovers. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
