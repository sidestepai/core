/**
 * `fl.alphaOk` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterAlphaOk = defineFunction({
  name: "ex_filter_alphaOk",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["alphaOk"]()))],
  response: ref("out"),
});
