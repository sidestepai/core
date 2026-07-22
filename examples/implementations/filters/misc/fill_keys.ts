/**
 * `fl.fill_keys` filter.
 * Create an array of keys with a default value.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterFillKeys = defineFunction({
  name: "ex_filter_fill_keys",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["fill_keys"]()))],
  response: ref("out"),
});
