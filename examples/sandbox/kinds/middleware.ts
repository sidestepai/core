/**
 * `middleware({...})` — a reusable pre/post request middleware (payload key
 * `middleware`). `resultStrategy` controls how its result merges into the
 * request flow (`merge` folds keys, `replace` swaps wholesale).
 *
 * A middleware runs only once *attached* to a host. Attach it with the host's
 * `middleware: { pre, post }` field — see `guardedEndpoint` below. Providing a
 * phase overrides that phase (sets its `_customize` flag); omitting it inherits
 * from the parent tier (Query → API Group → Workspace). `middleware.clear()`
 * overrides a phase with nothing (stop inheriting).
 */
import { middleware, query, s, c, ref, inp, input } from "@sidestep/core";
import { api, users } from "../_shared.js";

export const rateLimit = middleware({
  name: "ex_kind_rate_limit",
  resultStrategy: "merge",
  stack: [s.set_var("checked", c.bool(true))],
  response: ref("checked"),
});

export const auditLog = middleware({
  name: "ex_kind_audit_log",
  resultStrategy: "merge",
  exceptionPolicy: "silent",
  stack: [s.set_var("logged", c.bool(true))],
  response: ref("logged"),
});

/**
 * A query that runs `rateLimit` before its stack and `auditLog` after. Reference
 * middleware by def handle (or name); the binding resolves to the middleware's
 * guid, stable across syncs.
 */
export const guardedEndpoint = query({
  name: "ex_kind_guarded_endpoint",
  verb: "GET",
  apiGroup: api,
  input: { id: input.int({ required: true }) },
  middleware: { pre: [rateLimit], post: [auditLog] },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});
