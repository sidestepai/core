/**
 * `s.set_var(as, value)` — declare a new stack variable.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const setVar = defineFunction({
  name: "ex_set_var",
  stack: [s.set_var("greeting", c.text("hello"))],
  response: ref("greeting"),
});
