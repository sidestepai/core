/**
 * `fl.between` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterBetween = defineFunction({
  name: "ex_filter_between",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["between"]()))],
  response: ref("out"),
});
