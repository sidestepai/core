/**
 * `fl.filter` filter (group: array).
 * Filters the elements of an array based on the code block returning true to keep the element or false to skip it.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterFilter = defineFunction({
  name: "ex_filter_filter",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["filter"](c.text("x"))))],
  response: ref("out"),
});
