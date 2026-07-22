/**
 * `fl.not_equals` filter.
 * Returns a boolean if both values are not equal
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterNotEquals = defineFunction({
  name: "ex_filter_not_equals",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["not_equals"]()))],
  response: ref("out"),
});
