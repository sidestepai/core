/**
 * `rawValue()` — the value-level escape hatch codegen emits for a stored value it
 * cannot express through `c.*` / `ref` / `inp` / `withFilters`.
 *
 * `Value` is structurally just `{value, tag, filters}`, so an annotated literal
 * is already byte-exact; this wrapper exists for two reasons a bare literal does
 * not cover. It types the `tag` as a real `Tag` so the literal also checks out in
 * a widening position (a `const` declaration in a shared file, not only a
 * contextually-typed argument), and it makes every non-idiomatic value in a
 * generated tree greppable by one name.
 *
 * Reached via `@sidestep/core/codegen`, alongside `raw()` — same reasoning
 * (KTD-10): a passthrough should not sit in tab-completion next to `c.text`.
 */
import type { FilterXdo, Tag, TaggedValue } from "../types/xdo.js";

/** A stored value as it appears in a bundle. `filters` defaults to none. */
export interface RawValueInput {
  readonly value: string;
  readonly tag: Tag;
  readonly filters?: readonly FilterXdo[];
}

/** Carry a stored tagged value through verbatim. */
export function rawValue(v: RawValueInput): TaggedValue {
  return { value: v.value, tag: v.tag, filters: [...(v.filters ?? [])] };
}
