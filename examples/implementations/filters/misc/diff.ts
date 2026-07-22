/**
 * `fl.diff` filter.
 * Return the entries from the first array that are not in the second array. Only values are used for matching.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterDiff = defineFunction({
  name: "ex_filter_diff",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["diff"]()))],
  response: ref("out"),
});
