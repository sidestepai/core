/**
 * `fl.divide` filter.
 * Divide 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterDivide = defineFunction({
  name: "ex_filter_divide",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["divide"]()))],
  response: ref("out"),
});
