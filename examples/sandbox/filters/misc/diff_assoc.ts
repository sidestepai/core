/**
 * `fl.diff_assoc` filter.
 * Return the entries from the first array that are not in the second array. Values and keys are used for matching.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterDiffAssoc = defineFunction({
  name: "ex_filter_diff_assoc",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["diff_assoc"]()))],
  response: ref("out"),
});
