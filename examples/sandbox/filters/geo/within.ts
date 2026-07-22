/**
 * `fl.within` filter (group: geo).
 * Determines if one geometry is within the supplied radius of another geometry
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterWithin = defineFunction({
  name: "ex_filter_within",
  stack: [s.set_var("out", withFilters(c.obj({ type: "Point", coordinates: [0, 0] }), fl["within"](c.int(2), c.decimal(2))))],
  response: ref("out"),
});
