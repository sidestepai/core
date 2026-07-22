/**
 * `fl.format_timestamp` filter.
 * Converts a timestamp into a human readable formatted date based on the supplied format
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterFormatTimestamp = defineFunction({
  name: "ex_filter_format_timestamp",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["format_timestamp"]()))],
  response: ref("out"),
});
