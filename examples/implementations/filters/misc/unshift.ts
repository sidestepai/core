/**
 * `fl.unshift` filter.
 * Push an element to the beginning of an array and return the new array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterUnshift = defineFunction({
  name: "ex_filter_unshift",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["unshift"]()))],
  response: ref("out"),
});
