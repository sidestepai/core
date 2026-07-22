/**
 * `fl.lambda` filter (group: transform).
 * Business logic using JavaScript.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLambda = defineFunction({
  name: "ex_filter_lambda",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["lambda"](c.text("x"))))],
  response: ref("out"),
});
