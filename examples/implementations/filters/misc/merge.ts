/**
 * `fl.merge` filter.
 * Merge the first level of elements of both arrays together and return the new array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMerge = defineFunction({
  name: "ex_filter_merge",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["merge"]()))],
  response: ref("out"),
});
