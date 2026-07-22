/**
 * `fl.equals` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterEquals = defineFunction({
  name: "ex_filter_equals",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["equals"]()))],
  response: ref("out"),
});
