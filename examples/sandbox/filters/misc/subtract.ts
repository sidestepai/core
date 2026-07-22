/**
 * `fl.subtract` filter.
 * Subtract 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterSubtract = defineFunction({
  name: "ex_filter_subtract",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["subtract"]()))],
  response: ref("out"),
});
