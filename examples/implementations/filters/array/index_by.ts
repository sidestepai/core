/**
 * `fl.index_by` filter (group: array).
 * Create a new array indexed off of the value of each item's path
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterIndexBy = defineFunction({
  name: "ex_filter_index_by",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["index_by"](c.text("field"))))],
  response: ref("out"),
});
