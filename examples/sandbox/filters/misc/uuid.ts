/**
 * `fl.uuid` filter.
 * Returns a universally unique identifier
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterUuid = defineFunction({
  name: "ex_filter_uuid",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["uuid"]()))],
  response: ref("out"),
});
