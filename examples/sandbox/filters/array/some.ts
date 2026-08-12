/**
 * `fl.some` filter (group: array).
 * Checks if at least one element in the array passes the test implemented by the provided function.
 */
import { defineFunction, s, c, ref, withFilters, fl, lam } from "@sidestep/core";

export const filterSome = defineFunction({
  name: "ex_filter_some",
  stack: [
    s.set_var(
      "out",
      // true — 4 is over the threshold.
      withFilters(c.array([1, 2, 3, 4]), fl.some(lam.fn(({ $this }) => $this > 3, { surface: "some" }))),
    ),
  ],
  response: ref("out"),
});
