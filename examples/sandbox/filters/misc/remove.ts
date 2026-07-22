/**
 * `fl.remove` filter.
 * Remove any elements from the array that match the supplied value and then return the new array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterRemove = defineFunction({
  name: "ex_filter_remove",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["remove"]()))],
  response: ref("out"),
});
