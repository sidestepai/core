/**
 * `fl.timestamp_day_of_year` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampDayOfYear = defineFunction({
  name: "ex_filter_timestamp_day_of_year",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_day_of_year"]()))],
  response: ref("out"),
});
