/**
 * `fl.jws_decode` filter.
 * Decodes the JWS token and return the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterJwsDecode = defineFunction({
  name: "ex_filter_jws_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["jws_decode"]()))],
  response: ref("out"),
});
