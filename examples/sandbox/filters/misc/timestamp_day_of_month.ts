/**
 * `fl.timestamp_day_of_month` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampDayOfMonth = defineFunction({
  name: "ex_filter_timestamp_day_of_month",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_day_of_month"]()))],
  response: ref("out"),
});
