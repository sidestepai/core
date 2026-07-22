/**
 * `fl.minAlpha` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMinAlpha = defineFunction({
  name: "ex_filter_minAlpha",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["minAlpha"]()))],
  response: ref("out"),
});
