/**
 * `fl.fill` filter.
 * Create an array of a certain size with a default value.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterFill = defineFunction({
  name: "ex_filter_fill",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["fill"]()))],
  response: ref("out"),
});
