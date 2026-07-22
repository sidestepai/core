/**
 * `fl.iindex` filter.
 * Returns the index of the case-insensitive expression or false if it can't be found
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterIindex = defineFunction({
  name: "ex_filter_iindex",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["iindex"]()))],
  response: ref("out"),
});
