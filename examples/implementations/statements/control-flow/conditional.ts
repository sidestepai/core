/**
 * `s.conditional` — an `if (when) { then } else { else }` branch.
 *
 * PARAM GATE: `else` is optional. Each export shows one gate.
 */
import { defineFunction, s, c, ref, expr } from "@sidestep/core";

/** Gate 1 — `then` only (no else branch). */
export const conditionalThenOnly = defineFunction({
  name: "ex_conditional_then_only",
  stack: [
    s.set_var("n", c.int(3)),
    s.conditional({
      when: expr(ref("n"), ">", c.int(0)),
      then: [s.set_var("sign", c.text("positive"))],
    }),
  ],
  response: ref("sign"),
});

/** Gate 2 — `then` + `else`. */
export const conditionalThenElse = defineFunction({
  name: "ex_conditional_then_else",
  stack: [
    s.set_var("n", c.int(-3)),
    s.conditional({
      when: expr(ref("n"), ">=", c.int(0)),
      then: [s.set_var("sign", c.text("positive"))],
      else: [s.set_var("sign", c.text("negative"))],
    }),
  ],
  response: ref("sign"),
});
