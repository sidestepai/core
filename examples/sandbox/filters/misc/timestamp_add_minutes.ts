/**
 * `fl.timestamp_add_minutes` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTimestampAddMinutes = defineFunction({
  name: "ex_filter_timestamp_add_minutes",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["timestamp_add_minutes"]()))],
  response: ref("out"),
});
