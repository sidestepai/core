/**
 * `fl.l2_distance_euclidean` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterL2DistanceEuclidean = defineFunction({
  name: "ex_filter_l2_distance_euclidean",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["l2_distance_euclidean"]()))],
  response: ref("out"),
});
