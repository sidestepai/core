/**
 * `fl.number_format` filter (group: math).
 * Format a number with flexible support over decimal places, thousands separator, and decimal separator.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterNumberFormat = defineFunction({
  name: "ex_filter_number_format",
  stack: [s.set_var("out", withFilters(c.decimal(6.5), fl["number_format"]()))],
  response: ref("out"),
});
