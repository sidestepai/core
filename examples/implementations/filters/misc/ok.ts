/**
 * `fl.ok` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterOk = defineFunction({
  name: "ex_filter_ok",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["ok"]()))],
  response: ref("out"),
});
