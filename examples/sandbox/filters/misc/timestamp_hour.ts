/**
 * `fl.timestamp_hour` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampHour = defineFunction({
  name: "ex_filter_timestamp_hour",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_hour"]()))],
  response: ref("out"),
});
