/**
 * `fl.entries` filter.
 * Get the property entries of an object/array as a numerically indexed array of key/value pairs.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterEntries = defineFunction({
  name: "ex_filter_entries",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["entries"]()))],
  response: ref("out"),
});
