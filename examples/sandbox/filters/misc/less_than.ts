/**
 * `fl.less_than` filter.
 * Returns a boolean if the left value is less than the right value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLessThan = defineFunction({
  name: "ex_filter_less_than",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["less_than"]()))],
  response: ref("out"),
});
