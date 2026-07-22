/**
 * `fl.pop` filter.
 * Pops the last element of the array off and returns it
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterPop = defineFunction({
  name: "ex_filter_pop",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["pop"]()))],
  response: ref("out"),
});
