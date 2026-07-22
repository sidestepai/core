/**
 * `middleware({...})` — pre/post request middleware (payload key `middleware`).
 * `resultStrategy` controls how its result merges into the request flow.
 */
import { middleware, s, c, ref } from "@sidestep/core";

export const rateLimit = middleware({
  name: "ex_kind_rate_limit",
  resultStrategy: "merge",
  stack: [s.set_var("checked", c.bool(true))],
  response: ref("checked"),
});
