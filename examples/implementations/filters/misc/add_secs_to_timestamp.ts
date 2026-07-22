/**
 * `fl.add_secs_to_timestamp` filter.
 * Add seconds to a timestamp. (negative values are ok)
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterAddSecsToTimestamp = defineFunction({
  name: "ex_filter_add_secs_to_timestamp",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["add_secs_to_timestamp"]()))],
  response: ref("out"),
});
