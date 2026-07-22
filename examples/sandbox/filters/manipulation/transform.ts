/**
 * `fl.transform` filter (group: manipulation).
 * Processes an expression with local data bound to the $this variable
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterTransform = defineFunction({
  name: "ex_filter_transform",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["transform"](c.text("x"))))],
  response: ref("out"),
});
