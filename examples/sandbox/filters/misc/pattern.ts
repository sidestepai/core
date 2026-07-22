/**
 * `fl.pattern` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterPattern = defineFunction({
  name: "ex_filter_pattern",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["pattern"]()))],
  response: ref("out"),
});
