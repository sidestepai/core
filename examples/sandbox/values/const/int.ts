/**
 * `c.int(...)` — a constant int value (c.int → tagged constant).
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const constInt = defineFunction({
  name: "ex_value_const_int",
  stack: [s.set_var("v", c.int(42))],
  response: ref("v"),
});
