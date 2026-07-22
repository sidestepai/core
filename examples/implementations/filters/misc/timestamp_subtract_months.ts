/**
 * `fl.timestamp_subtract_months` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampSubtractMonths = defineFunction({
  name: "ex_filter_timestamp_subtract_months",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_subtract_months"]()))],
  response: ref("out"),
});
