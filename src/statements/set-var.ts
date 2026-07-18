/**
 * `setVar` / `updateVar` statements (U5/U10) — the `!var` family. Both carry
 * their value in `context` (not `input[]`), a per-statement quirk confirmed by
 * the golden fixtures. They differ in how the target variable is named:
 *
 * - `set_var` declares a *new* stack variable via the top-level `as` slot
 *   (`var $x1 { value = ... }`) and emits no `output` envelope.
 * - `update_var` reassigns an *existing* stack variable named inside
 *   `context.name` (`update $x1 { value = ... }`), has no `as`, and carries a
 *   lean `output:{filters:[]}` envelope.
 */
import type { Statement } from "./statement.js";
import { registerStatement } from "./statement.js";
import type { Value } from "../values/value.js";

export const SET_VAR = "mvp:set_var";
export const UPDATE_VAR = "mvp:update_var";

/** Assign `value` to stack variable `as` (`var $as { value = ... }`). */
export function setVar(as: string, value: Value): Statement {
  return {
    name: SET_VAR,
    as,
    context: { value: value.value, tag: value.tag, filters: value.filters },
  };
}

/** Reassign existing stack variable `name` to `value` (`update $name { value = ... }`). */
export function updateVar(name: string, value: Value): Statement {
  return {
    name: UPDATE_VAR,
    context: { name, value: value.value, tag: value.tag, filters: value.filters },
    output: { filters: [] },
  };
}

registerStatement(SET_VAR, setVar);
registerStatement(UPDATE_VAR, updateVar);
