/**
 * `fl.minUpperAlpha` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMinUpperAlpha = defineFunction({
  name: "ex_filter_minUpperAlpha",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["minUpperAlpha"]()))],
  response: ref("out"),
});
