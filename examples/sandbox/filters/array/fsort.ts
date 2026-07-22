/**
 * `fl.fsort` filter (group: array).
 * Sort an array of elements with an optional path inside the element
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterFsort = defineFunction({
  name: "ex_filter_fsort",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["fsort"](c.text("field"))))],
  response: ref("out"),
});
