/**
 * `middleware({...})` — a reusable pre/post request middleware (payload key
 * `middleware`). `resultStrategy` controls how its result merges into the
 * request flow (`merge` folds keys, `replace` swaps wholesale); `exceptionPolicy`
 * controls what a throw in the stack does to the request (`rethrow` aborts and
 * surfaces the error — what a guard wants; `silent`, the default, swallows it).
 *
 * A middleware runs only once *attached* to a host. Attach it with the host's
 * `middleware: { pre, post }` field — see `guardedEndpoint` below. Providing a
 * phase overrides that phase (sets its `_customize` flag); omitting it inherits
 * from the parent tier (Query → API Group → Workspace). `middleware.clear()`
 * overrides a phase with nothing (stop inheriting).
 */
import { middleware, query, s, c, ref, inp, input, auth, sys, withFilters, fl } from "@sidestep/core";
import { api, users } from "../_shared.js";

/**
 * A per-user rate limiter — the canonical middleware. Two non-obvious parts:
 *
 * 1. **Composite key.** `s.redis.ratelimit` takes a `Value` key; to namespace the
 *    bucket per user you build it with the filter chain, not string concat
 *    (`"prefix" + auth("id")` does not exist). `withFilters(c.text(prefix),
 *    fl.concat(auth("id")))` → `"ex:rl:write:<id>"`.
 * 2. **`auth("id")` needs an authenticated host.** It resolves to the caller's id
 *    only when the host has an auth table; on a public host it is `null` and every
 *    caller shares one bucket. `export()` warns if you attach this to a host with
 *    no auth table — so the `guardedEndpoint` query below sets `auth: users`.
 *
 * `exceptionPolicy: "rethrow"` makes a tripped limit abort the request (HTTP 429
 * with the authored `error`); the default `"silent"` would let it through.
 */
export const rateLimit = middleware({
  name: "ex_kind_rate_limit",
  exceptionPolicy: "rethrow",
  stack: [
    s.redis.ratelimit({
      key: withFilters(c.text("ex:rl:write:"), fl.concat(auth("id"))),
      max: c.int(10),
      ttl: c.int(30),
      error: c.text("Too fast — slow down."),
    }),
  ],
});

/**
 * The **public-endpoint** rate limiter. On a host with no auth table `auth("id")`
 * is null, so an `auth("id")`-keyed limit collapses every anonymous caller into
 * one shared bucket. Key off the client IP instead — `sys.remoteIp()` (Xano's
 * `$env.$remote_ip`). Same composite-key pattern; just a different key source.
 *
 * To key off a request *field* instead (e.g. an email being submitted), a `pre`
 * middleware can read the host body: `s.util.get_all_input({ as: "payload" })`
 * exposes it — but wrapped as `{ type, vars }`, so the field is at
 * `ref("payload.vars.<field>")`, not `ref("payload.<field>")`.
 */
export const publicRateLimit = middleware({
  name: "ex_kind_public_rate_limit",
  exceptionPolicy: "rethrow",
  stack: [
    s.redis.ratelimit({
      key: withFilters(c.text("ex:rl:public:"), fl.concat(sys.remoteIp())),
      max: c.int(20),
      ttl: c.int(60),
      error: c.text("Too many requests — try again shortly."),
    }),
  ],
});

export const auditLog = middleware({
  name: "ex_kind_audit_log",
  resultStrategy: "merge",
  exceptionPolicy: "silent",
  stack: [s.set_var("logged", c.bool(true))],
  response: ref("logged"),
});

/**
 * An authenticated query that runs `rateLimit` before its stack and `auditLog`
 * after. The endpoint's `auth: users` is what makes `auth("id")` inside the
 * rate-limit key resolve to the caller (a public endpoint would collapse all
 * callers into one bucket — and `export()` would warn).
 *
 * Shared-bucket note: attaching this one `rateLimit` object to several endpoints
 * means they share the *same* key and therefore *one* counter — `max: 10` becomes
 * a global per-user budget across all of them. For an independent limit per
 * endpoint, vary the key (fold the endpoint/action name into the prefix).
 */
export const guardedEndpoint = query({
  name: "ex_kind_guarded_endpoint",
  verb: "POST",
  apiGroup: api,
  auth: users,
  input: { id: input.int({ required: true }) },
  middleware: { pre: [rateLimit], post: [auditLog] },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});
