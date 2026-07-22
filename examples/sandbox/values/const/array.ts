/**
 * `c.array(...)` — a constant array value (c.array → tagged constant).
 * Plain JSON literals only — a nested tagged value (inp/ref/auth/c.*) is
 * rejected; for a computed object use a record of values, not c.obj (issue #42).
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const constArray = defineFunction({
  name: "ex_value_const_array",
  stack: [s.set_var("v", c.array([1, 2, 3]))],
  response: ref("v"),
});
