/**
 * `fl.timestamp_epoch_sec` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampEpochSec = defineFunction({
  name: "ex_filter_timestamp_epoch_sec",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_epoch_sec"]()))],
  response: ref("out"),
});
