/**
 * `s.expect.to_throw({ body, exception? })` — assert a sub-stack raises (test).
 */
import { defineFunction, s, c } from "@sidestep/core";

export const expectToThrow = defineFunction({
  name: "ex_expect_to_throw",
  stack: [
    s.expect.to_throw({
      body: [s.throw({ value: c.text("boom") })],
    }),
  ],
});
