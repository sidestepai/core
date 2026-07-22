/**
 * `fl.inner_product` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterInnerProduct = defineFunction({
  name: "ex_filter_inner_product",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["inner_product"]()))],
  response: ref("out"),
});
