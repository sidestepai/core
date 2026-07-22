/**
 * `s.return(value)` — terminate the stack and return a value.
 */
import { defineFunction, s, c } from "@sidestep/core";

export const returnStmt = defineFunction({
  name: "ex_return",
  stack: [s.return(c.text("done"))],
});
