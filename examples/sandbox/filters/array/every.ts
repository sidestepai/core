/**
 * `fl.every` filter (group: array).
 * Checks if all elements in the array pass the test implemented by the provided function.
 */
import { defineFunction, s, c, ref, withFilters, fl, lam } from "@sidestep/core";

export const filterEvery = defineFunction({
  name: "ex_filter_every",
  stack: [
    s.set_var(
      "out",
      // true — every element is positive.
      withFilters(c.array([1, 2, 3, 4]), fl.every(lam.fn(({ $this }) => $this > 0, { surface: "every" }))),
    ),
  ],
  response: ref("out"),
});
