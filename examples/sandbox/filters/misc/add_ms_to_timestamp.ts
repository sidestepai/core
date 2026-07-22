/**
 * `fl.add_ms_to_timestamp` filter.
 * Add milliseconds to a timestamp. (negative values are ok)
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterAddMsToTimestamp = defineFunction({
  name: "ex_filter_add_ms_to_timestamp",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["add_ms_to_timestamp"]()))],
  response: ref("out"),
});
