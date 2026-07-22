/**
 * `fl.escape` filter (group: text).
 * Converts special characters into their escaped variants. Ex: for tabs and
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterEscape = defineFunction({
  name: "ex_filter_escape",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["escape"]()))],
  response: ref("out"),
});
