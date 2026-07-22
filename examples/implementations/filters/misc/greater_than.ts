/**
 * `fl.greater_than` filter.
 * Returns a boolean if the left value is greater than the right value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterGreaterThan = defineFunction({
  name: "ex_filter_greater_than",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["greater_than"]()))],
  response: ref("out"),
});
