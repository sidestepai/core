/**
 * `fl.timestamp_subtract_days` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampSubtractDays = defineFunction({
  name: "ex_filter_timestamp_subtract_days",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_subtract_days"]()))],
  response: ref("out"),
});
