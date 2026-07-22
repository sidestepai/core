/**
 * `fl.keys` filter.
 * Get the property keys of an object/array as a numerically indexed array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterKeys = defineFunction({
  name: "ex_filter_keys",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["keys"]()))],
  response: ref("out"),
});
