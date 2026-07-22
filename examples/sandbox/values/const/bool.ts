/**
 * `c.bool(...)` — a constant bool value (c.bool → tagged constant).
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const constBool = defineFunction({
  name: "ex_value_const_bool",
  stack: [s.set_var("v", c.bool(true))],
  response: ref("v"),
});
