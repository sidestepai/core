/**
 * `fl.minLowerAlpha` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMinLowerAlpha = defineFunction({
  name: "ex_filter_minLowerAlpha",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["minLowerAlpha"]()))],
  response: ref("out"),
});
