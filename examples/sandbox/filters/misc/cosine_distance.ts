/**
 * `fl.cosine_distance` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCosineDistance = defineFunction({
  name: "ex_filter_cosine_distance",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["cosine_distance"]()))],
  response: ref("out"),
});
