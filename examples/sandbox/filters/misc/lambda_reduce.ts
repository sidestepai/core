/**
 * `fl.lambda_reduce` filter.
 * Like `reduce`, but the reducer is written as a string of JS/TS code. Takes an initial value before the code block, and an optional final argument that sets a timeout (in seconds).
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLambdaReduce = defineFunction({
  name: "ex_filter_lambda_reduce",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["lambda_reduce"]()))],
  response: ref("out"),
});
