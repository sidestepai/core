/**
 * `fl.push` filter.
 * Push an element on to the end of an array and return the new array
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterPush = defineFunction({
  name: "ex_filter_push",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["push"]()))],
  response: ref("out"),
});
