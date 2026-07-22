/**
 * `fl.to_upper` filter.
 * Converts all characters to upper case and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToUpper = defineFunction({
  name: "ex_filter_to_upper",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_upper"]()))],
  response: ref("out"),
});
