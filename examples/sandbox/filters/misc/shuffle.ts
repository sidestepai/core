/**
 * `fl.shuffle` filter.
 * Shuffles the order of the entries in the array.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterShuffle = defineFunction({
  name: "ex_filter_shuffle",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["shuffle"]()))],
  response: ref("out"),
});
