/**
 * `fl.to_distinct_list_asc` filter (group: aggregate functions).
 * aggregate to a distinct array sorted in ascending order
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToDistinctListAsc = defineFunction({
  name: "ex_filter_to_distinct_list_asc",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["to_distinct_list_asc"]()))],
  response: ref("out"),
});
