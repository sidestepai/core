/**
 * `fl.jws_encode` filter.
 * Encodes the value and return the result as a JWS token
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterJwsEncode = defineFunction({
  name: "ex_filter_jws_encode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["jws_encode"]()))],
  response: ref("out"),
});
