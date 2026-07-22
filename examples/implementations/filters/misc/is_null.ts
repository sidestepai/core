/**
 * `fl.is_null` filter.
 * Returns whether or not the value is null
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterIsNull = defineFunction({
  name: "ex_filter_is_null",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["is_null"]()))],
  response: ref("out"),
});
