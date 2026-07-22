/**
 * `fl.lambda_find` filter.
 * Like `find`, but the predicate is written as a string of JS/TS code. An optional final argument sets a timeout (in seconds).
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLambdaFind = defineFunction({
  name: "ex_filter_lambda_find",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["lambda_find"]()))],
  response: ref("out"),
});
