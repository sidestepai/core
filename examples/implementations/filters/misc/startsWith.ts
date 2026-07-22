/**
 * `fl.startsWith` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterStartsWith = defineFunction({
  name: "ex_filter_startsWith",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["startsWith"]()))],
  response: ref("out"),
});
