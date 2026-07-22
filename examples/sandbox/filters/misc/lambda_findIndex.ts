/**
 * `fl.lambda_findIndex` filter.
 * Like `findIndex`, but the predicate is written as a string of JS/TS code. An optional final argument sets a timeout (in seconds).
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLambdaFindIndex = defineFunction({
  name: "ex_filter_lambda_findIndex",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["lambda_findIndex"]()))],
  response: ref("out"),
});
