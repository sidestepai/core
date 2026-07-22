/**
 * `fl.median` filter (group: aggregate functions).
 * Median
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMedian = defineFunction({
  name: "ex_filter_median",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["median"]()))],
  response: ref("out"),
});
