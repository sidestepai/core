/**
 * `fl.intersect_assoc` filter.
 * Return the entries from the first array that are also present in the second array. Values and keys are used for matching.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterIntersectAssoc = defineFunction({
  name: "ex_filter_intersect_assoc",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["intersect_assoc"]()))],
  response: ref("out"),
});
