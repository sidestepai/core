/**
 * `fl.to_hours` filter.
 * Converts a text expression (now, next friday, Jan 1 2000) to the number of hours since the unix epoch.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToHours = defineFunction({
  name: "ex_filter_to_hours",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_hours"]()))],
  response: ref("out"),
});
