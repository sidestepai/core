/**
 * `fl.timestamp_epoch_day` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampEpochDay = defineFunction({
  name: "ex_filter_timestamp_epoch_day",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_epoch_day"]()))],
  response: ref("out"),
});
