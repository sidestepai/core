/**
 * `fl.distance` filter (group: geo).
 * Provides the distance in meters between two geometries
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterDistance = defineFunction({
  name: "ex_filter_distance",
  stack: [s.set_var("out", withFilters(c.obj({ type: "Point", coordinates: [0, 0] }), fl["distance"](c.int(2))))],
  response: ref("out"),
});
