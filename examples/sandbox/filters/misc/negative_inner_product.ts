/**
 * `fl.negative_inner_product` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterNegativeInnerProduct = defineFunction({
  name: "ex_filter_negative_inner_product",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["negative_inner_product"]()))],
  response: ref("out"),
});
