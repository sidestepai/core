/**
 * `fl.minSymbol` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMinSymbol = defineFunction({
  name: "ex_filter_minSymbol",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["minSymbol"]()))],
  response: ref("out"),
});
