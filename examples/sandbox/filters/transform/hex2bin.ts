/**
 * `fl.hex2bin` filter (group: transform).
 * Converts a hex value into its binary equivalent
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterHex2bin = defineFunction({
  name: "ex_filter_hex2bin",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["hex2bin"]()))],
  response: ref("out"),
});
