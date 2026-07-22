/**
 * `fl.length` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLength = defineFunction({
  name: "ex_filter_length",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["length"]()))],
  response: ref("out"),
});
