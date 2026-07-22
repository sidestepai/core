/**
 * `fl.index` filter.
 * Returns the index of the case-sensitive expression or false if it can't be found
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterIndex = defineFunction({
  name: "ex_filter_index",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["index"]()))],
  response: ref("out"),
});
