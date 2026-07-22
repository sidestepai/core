/**
 * `fl.lambda_map` filter.
 * Like `map`, but the transform is written as a string of JS/TS code instead of an inline XanoScript expression. An optional final argument sets a timeout (in seconds).
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLambdaMap = defineFunction({
  name: "ex_filter_lambda_map",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["lambda_map"]()))],
  response: ref("out"),
});
