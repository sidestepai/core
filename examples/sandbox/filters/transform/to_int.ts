/**
 * `fl.to_int` filter (group: transform).
 * Converts text, decimal, or bool types to an integer and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToInt = defineFunction({
  name: "ex_filter_to_int",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_int"]()))],
  response: ref("out"),
});
