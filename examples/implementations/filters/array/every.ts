/**
 * `fl.every` filter (group: array).
 * Checks if all elements in the array pass the test implemented by the provided function.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterEvery = defineFunction({
  name: "ex_filter_every",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["every"](c.text("x"))))],
  response: ref("out"),
});
