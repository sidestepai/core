/**
 * `fl.timestamp_minute` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampMinute = defineFunction({
  name: "ex_filter_timestamp_minute",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_minute"]()))],
  response: ref("out"),
});
