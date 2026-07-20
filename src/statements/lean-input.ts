/**
 * The lean statement-input entry — `{name, tag, value, filters}` — shared by
 * every call site that emits the *lean* input form (no rich
 * `ignore`/`expand`/`children`):
 *
 * - addon `input[]` bindings ({@link ../statements/special/addon-encode.ts}),
 * - the lean db family (`db.add_or_edit` / the bulk ops in
 *   {@link ../statements/special/db.ts}),
 * - lean spec-driven statements ({@link ../statements/schema-dsl/interpret.ts}).
 *
 * One builder so the shape lives in exactly one place. (JSON key order is not
 * significant to the engine parser, which reads by field name.)
 */
import type { Value } from "../values/value.js";

/** A lean input binding — `{name, tag, value, filters}`, no `ignore/expand/children`. */
export interface LeanInput {
  name: string;
  tag: string;
  value: string;
  filters: unknown[];
}

/** Build a lean input entry from an authored {@link Value}. */
export function leanInput(name: string, v: Value): LeanInput {
  return { name, tag: v.tag, value: v.value, filters: v.filters };
}
