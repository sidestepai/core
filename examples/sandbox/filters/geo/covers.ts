/**
 * `fl.covers` filter (group: geo).
 * Determines if one geometry covers another
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCovers = defineFunction({
  name: "ex_filter_covers",
  stack: [s.set_var("out", withFilters(c.obj({ type: "Point", coordinates: [0, 0] }), fl["covers"](c.int(2))))],
  response: ref("out"),
});
