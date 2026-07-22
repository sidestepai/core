/**
 * `fl.prevent` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterPrevent = defineFunction({
  name: "ex_filter_prevent",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["prevent"]()))],
  response: ref("out"),
});
