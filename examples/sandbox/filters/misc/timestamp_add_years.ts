/**
 * `fl.timestamp_add_years` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampAddYears = defineFunction({
  name: "ex_filter_timestamp_add_years",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_add_years"]()))],
  response: ref("out"),
});
