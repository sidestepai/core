/**
 * `fl.coalesce` filter (group: manipulation).
 * Provides an alternative value for null values
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCoalesce = defineFunction({
  name: "ex_filter_coalesce",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["coalesce"](c.text("x"))))],
  response: ref("out"),
});
