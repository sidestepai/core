/**
 * `fl.reduce` filter (group: array).
 * Reduces the array to a single value using the code block to combine each element of the array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterReduce = defineFunction({
  name: "ex_filter_reduce",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["reduce"](c.text("x"))))],
  response: ref("out"),
});
