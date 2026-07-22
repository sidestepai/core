/**
 * `fl.replace` filter.
 * Replace all occurrences of a text phrase with another
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterReplace = defineFunction({
  name: "ex_filter_replace",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["replace"]()))],
  response: ref("out"),
});
