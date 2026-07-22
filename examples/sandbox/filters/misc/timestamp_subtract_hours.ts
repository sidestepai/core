/**
 * `fl.timestamp_subtract_hours` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampSubtractHours = defineFunction({
  name: "ex_filter_timestamp_subtract_hours",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_subtract_hours"]()))],
  response: ref("out"),
});
