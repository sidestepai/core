/**
 * `fl.search_rank` filter (group: search).
 * Calculate a ranking value for the search match
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterSearchRank = defineFunction({
  name: "ex_filter_search_rank",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["search_rank"](c.text("x"))))],
  response: ref("out"),
});
