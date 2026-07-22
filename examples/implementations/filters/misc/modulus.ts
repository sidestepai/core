/**
 * `fl.modulus` filter.
 * Modulus 2 values together and return the answer
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterModulus = defineFunction({
  name: "ex_filter_modulus",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["modulus"]()))],
  response: ref("out"),
});
