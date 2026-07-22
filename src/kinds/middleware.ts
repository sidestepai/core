/**
 * Middleware kind (U8) → payload key `middleware`. Function-like
 * (input/run/result) plus `result_type` (merge|replace) and `exception`
 * (silent|rethrow|critical). Validated against `cloud-client: …/process/
 * schema:middleware`.
 */
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags, defaultHistory } from "./common.js";
import { clear } from "./middleware-attach.js";

export type ResultStrategy = "merge" | "replace";
/**
 * What Xano does to the request when the middleware stack **throws** (e.g. a
 * tripped `s.redis.ratelimit`). SideStep passes the value through verbatim; the
 * engine (`Api\handler\ApiQuery` + `helper\Middleware`) interprets it:
 *
 * - `"silent"` **(default)** — the throw is swallowed; the host continues as if
 *   the middleware succeeded. For a guard (rate limit, auth check) this means the
 *   guard is **not enforced** — the over-limit request goes through. Set this
 *   only for advisory middleware (logging, metrics) that must never block.
 * - `"rethrow"` — the throw aborts the request and the authored `error`/status
 *   surfaces to the caller (a tripped `ratelimit` → HTTP 429). The `post` chain
 *   still runs. This is what a guard-style middleware wants.
 * - `"critical"` — like `"rethrow"` (same aborted request, same HTTP status) but
 *   additionally **skips the entire `post` middleware chain**. Use it when a
 *   failed `pre` guard should suppress post-processing (audit shaping, response
 *   rewrites) that assumes the host ran.
 *
 * No status or logging difference between `rethrow` and `critical` — the only
 * distinction is whether `post` middleware runs.
 */
export type ExceptionPolicy = "silent" | "rethrow" | "critical";

export interface MiddlewareDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  resultStrategy?: ResultStrategy;
  /**
   * How a throw in the stack affects the request. Defaults to `"silent"` (the
   * throw is swallowed — a guard is **not** enforced). A rate limiter or auth
   * check wants `"rethrow"`. See {@link ExceptionPolicy} for all three.
   */
  exceptionPolicy?: ExceptionPolicy;
  tags?: string[];
  input?: Record<string, InputDescriptor>;
  stack?: Statement[];
  response?: ResponseDef;
}

export interface MiddlewareXdo {
  name: string;
  description: string;
  docs: string;
  result_type: ResultStrategy;
  exception: ExceptionPolicy;
  history: { inherit: boolean; enabled: boolean; limit: number };
  tag: Array<{ tag: string }>;
  shared_workspace: { is_shared: boolean };
  input: InputXdo[];
  result: ResultItemXdo[];
  run: StackItemXdo[];
  test: unknown[];
}

export function encodeMiddleware(def: MiddlewareDef): MiddlewareXdo {
  if (!def.name) throw new Error("middleware: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    result_type: def.resultStrategy ?? "merge",
    exception: def.exceptionPolicy ?? "silent",
    history: defaultHistory("middleware"),
    tag: encodeTags(def.tags),
    shared_workspace: { is_shared: false },
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    result: encodeResponse(def.response),
    run: (def.stack ?? []).map(encodeStatement),
    test: [],
  };
}

export const middlewareKind: ObjectKind<MiddlewareDef, MiddlewareXdo> = {
  name: "middleware",
  payloadKey: "middleware",
  encode: encodeMiddleware,
};
registerKind(middlewareKind);

function middlewareImpl(def: MiddlewareDef): MiddlewareDef {
  return def;
}

/**
 * Author a middleware object. Callable as `middleware({…})`; also carries
 * {@link clear} as `middleware.clear()` — the readable spelling of an explicit
 * empty pre/post override (`pre: middleware.clear()` ⇒ customize the phase, run
 * nothing, stop inheriting the parent tier).
 */
export const middleware = Object.assign(middlewareImpl, { clear });
