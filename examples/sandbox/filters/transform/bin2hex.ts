/**
 * `fl.bin2hex` filter (group: transform).
 * Converts a binary value into its hex equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterBin2hex = defineFunction({
  name: "ex_filter_bin2hex",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["bin2hex"]()))],
  response: ref("out"),
});
