/**
 * `fl.to_timestamp` filter.
 * Converts a text expression (now, next friday, Jan 1 2000) to timestamp compatible format.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterToTimestamp = defineFunction({
  name: "ex_filter_to_timestamp",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_timestamp"]()))],
  response: ref("out"),
});
