/**
 * `fl.array_fill_keys` filter (group: manipulation).
 * Create an array of keys with a default value.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterArrayFillKeys = defineFunction({
  name: "ex_filter_array_fill_keys",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["array_fill_keys"]()))],
  response: ref("out"),
});
