/**
 * `fl.minDigit` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMinDigit = defineFunction({
  name: "ex_filter_minDigit",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["minDigit"]()))],
  response: ref("out"),
});
