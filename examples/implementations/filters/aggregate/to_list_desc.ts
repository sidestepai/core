/**
 * `fl.to_list_desc` filter (group: aggregate functions).
 * aggregate to an array sorted in descending order
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToListDesc = defineFunction({
  name: "ex_filter_to_list_desc",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["to_list_desc"]()))],
  response: ref("out"),
});
