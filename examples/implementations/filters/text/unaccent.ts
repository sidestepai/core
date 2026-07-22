/**
 * `fl.unaccent` filter (group: text).
 * Removes accents from characters
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterUnaccent = defineFunction({
  name: "ex_filter_unaccent",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["unaccent"]()))],
  response: ref("out"),
});
