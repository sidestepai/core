/**
 * `fl.to_lower` filter.
 * Converts all characters to lower case and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToLower = defineFunction({
  name: "ex_filter_to_lower",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_lower"]()))],
  response: ref("out"),
});
