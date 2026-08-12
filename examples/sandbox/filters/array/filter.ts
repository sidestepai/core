/**
 * `fl.filter` filter (group: array).
 * Filters the elements of an array based on the code block returning true to keep the element or false to skip it.
 */
import { defineFunction, s, c, ref, withFilters, fl, lam } from "@sidestep/core";

export const filterFilter = defineFunction({
  name: "ex_filter_filter",
  stack: [
    s.set_var(
      "out",
      // Keeps [2, 4] — the body returns whether to keep each element.
      withFilters(c.array([1, 2, 3, 4]), fl.filter(lam.fn(({ $this }) => $this % 2 === 0, { surface: "filter" }))),
    ),
  ],
  response: ref("out"),
});
