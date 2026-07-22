/**
 * `fl.count_distinct` filter (group: aggregate functions).
 * count distinct
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCountDistinct = defineFunction({
  name: "ex_filter_count_distinct",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["count_distinct"]()))],
  response: ref("out"),
});
