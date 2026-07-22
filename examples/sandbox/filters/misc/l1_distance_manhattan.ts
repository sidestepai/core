/**
 * `fl.l1_distance_manhattan` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterL1DistanceManhattan = defineFunction({
  name: "ex_filter_l1_distance_manhattan",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["l1_distance_manhattan"]()))],
  response: ref("out"),
});
