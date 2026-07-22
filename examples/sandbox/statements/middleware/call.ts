/**
 * `s.middleware.call({ middleware, input?, as? })` — invoke middleware as a run.
 */
import { defineFunction, s, ref } from "@sidestep/core";

export const middlewareCall = defineFunction({
  name: "ex_middleware_call",
  stack: [s.middleware.call({ middleware: "ex_rate_limit", as: "res" })],
  response: ref("res"),
});
