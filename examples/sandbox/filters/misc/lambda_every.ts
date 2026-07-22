/**
 * `fl.lambda_every` filter.
 * Like `every`, but the predicate is written as a string of JS/TS code. An optional final argument sets a timeout (in seconds).
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterLambdaEvery = defineFunction({
  name: "ex_filter_lambda_every",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["lambda_every"]()))],
  response: ref("out"),
});
