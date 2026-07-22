/**
 * `fl.transform_timestamp` filter.
 * Takes a timestamp and applies a relative transformation to it. Ex. -7 days, last Monday, first day of this month
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTransformTimestamp = defineFunction({
  name: "ex_filter_transform_timestamp",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["transform_timestamp"]()))],
  response: ref("out"),
});
