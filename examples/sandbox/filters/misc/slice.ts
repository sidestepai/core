/**
 * `fl.slice` filter.
 * Extract a section from an array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterSlice = defineFunction({
  name: "ex_filter_slice",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["slice"]()))],
  response: ref("out"),
});
