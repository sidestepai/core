/**
 * `fl.parse_timestamp` filter.
 * Parse a timestamp from a flexible format.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterParseTimestamp = defineFunction({
  name: "ex_filter_parse_timestamp",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["parse_timestamp"]()))],
  response: ref("out"),
});
