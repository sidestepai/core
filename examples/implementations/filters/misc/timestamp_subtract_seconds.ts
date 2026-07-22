/**
 * `fl.timestamp_subtract_seconds` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampSubtractSeconds = defineFunction({
  name: "ex_filter_timestamp_subtract_seconds",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_subtract_seconds"]()))],
  response: ref("out"),
});
