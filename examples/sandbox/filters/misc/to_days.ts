/**
 * `fl.to_days` filter.
 * Converts a text expression (now, next friday, Jan 1 2000) to the number of days since the unix epoch.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToDays = defineFunction({
  name: "ex_filter_to_days",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_days"]()))],
  response: ref("out"),
});
