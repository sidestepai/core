/**
 * `fl.to_list` filter (group: aggregate functions).
 * aggregate to an array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToList = defineFunction({
  name: "ex_filter_to_list",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["to_list"]()))],
  response: ref("out"),
});
