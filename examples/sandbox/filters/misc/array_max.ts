/**
 * `fl.array_max` filter.
 * Returns the max of the values of the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterArrayMax = defineFunction({
  name: "ex_filter_array_max",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["array_max"]()))],
  response: ref("out"),
});
