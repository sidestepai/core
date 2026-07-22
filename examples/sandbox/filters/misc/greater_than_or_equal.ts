/**
 * `fl.greater_than_or_equal` filter.
 * Returns a boolean if the left value is greater than or equal to the right value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterGreaterThanOrEqual = defineFunction({
  name: "ex_filter_greater_than_or_equal",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["greater_than_or_equal"]()))],
  response: ref("out"),
});
