/**
 * `fl.some` filter (group: array).
 * Checks if at least one element in the array passes the test implemented by the provided function.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterSome = defineFunction({
  name: "ex_filter_some",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["some"](c.text("x"))))],
  response: ref("out"),
});
