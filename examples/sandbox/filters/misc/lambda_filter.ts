/**
 * `fl.lambda_filter` filter.
 * Like `filter`, but the predicate is written as a string of JS/TS code. Return a truthy value to keep the element. An optional final argument sets a timeout (in seconds).
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLambdaFilter = defineFunction({
  name: "ex_filter_lambda_filter",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["lambda_filter"]()))],
  response: ref("out"),
});
