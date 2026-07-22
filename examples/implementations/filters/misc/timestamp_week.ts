/**
 * `fl.timestamp_week` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampWeek = defineFunction({
  name: "ex_filter_timestamp_week",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_week"]()))],
  response: ref("out"),
});
