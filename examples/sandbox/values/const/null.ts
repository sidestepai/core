/**
 * `c.null(...)` — a constant null value (c.null → tagged constant).
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const constNull = defineFunction({
  name: "ex_value_const_null",
  stack: [s.set_var("v", c.null())],
  response: ref("v"),
});
