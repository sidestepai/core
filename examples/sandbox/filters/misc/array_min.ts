/**
 * `fl.array_min` filter.
 * Returns the min of the values of the array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterArrayMin = defineFunction({
  name: "ex_filter_array_min",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["array_min"]()))],
  response: ref("out"),
});
