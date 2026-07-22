/**
 * `fl.timestamp_subtract_minutes` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampSubtractMinutes = defineFunction({
  name: "ex_filter_timestamp_subtract_minutes",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_subtract_minutes"]()))],
  response: ref("out"),
});
