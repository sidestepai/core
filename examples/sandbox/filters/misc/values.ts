/**
 * `fl.values` filter.
 * Get the property values of an object/array as a numerically indexed array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterValues = defineFunction({
  name: "ex_filter_values",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["values"]()))],
  response: ref("out"),
});
