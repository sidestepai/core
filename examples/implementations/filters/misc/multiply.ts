/**
 * `fl.multiply` filter.
 * Multiply 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterMultiply = defineFunction({
  name: "ex_filter_multiply",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["multiply"]()))],
  response: ref("out"),
});
