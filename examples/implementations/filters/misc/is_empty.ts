/**
 * `fl.is_empty` filter.
 * Returns whether or not the value is empty ("", null, 0, "0", false, [], {})
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterIsEmpty = defineFunction({
  name: "ex_filter_is_empty",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["is_empty"]()))],
  response: ref("out"),
});
