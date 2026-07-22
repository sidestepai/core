/**
 * `fl.merge_recursive` filter.
 * Merge the elements from all levels of both arrays together and return the new array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMergeRecursive = defineFunction({
  name: "ex_filter_merge_recursive",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["merge_recursive"]()))],
  response: ref("out"),
});
