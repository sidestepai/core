/**
 * `fl.findIndex` filter (group: array).
 * Finds the index of the first element in the array that passes the test implemented by the provided function.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterFindIndex = defineFunction({
  name: "ex_filter_findIndex",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["findIndex"](c.text("x"))))],
  response: ref("out"),
});
