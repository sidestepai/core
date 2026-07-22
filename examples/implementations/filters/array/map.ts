/**
 * `fl.map` filter (group: array).
 * Creates a new array with the results of calling a provided function on every element in the calling array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMap = defineFunction({
  name: "ex_filter_map",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["map"](c.text("x"))))],
  response: ref("out"),
});
