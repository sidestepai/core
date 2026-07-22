/**
 * `fl.intersect` filter.
 * Return the entries from the first array that are also present in the second array. Only values are used for matching.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterIntersect = defineFunction({
  name: "ex_filter_intersect",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["intersect"]()))],
  response: ref("out"),
});
