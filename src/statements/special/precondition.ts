/**
 * Typed `precondition` / `throw` overrides (issue #21).
 *
 * `s.throw` raises a generic error the runtime returns with **HTTP 200** and an
 * error body — a client checking `res.ok` (or any non-2xx guard) treats a
 * deliberately-thrown error as success. `s.precondition` instead maps its
 * `error_type` to a status-bearing exception (400/401/403/404/429/…), so a
 * boundary rejection is observable via standard HTTP semantics.
 *
 * Both delegate to the codegen'd factory — the encoded statement is identical —
 * and only narrow/annotate the authoring types. `error_type` in particular ships
 * from codegen as a bare `string`; here it becomes the engine's enum so the
 * valid values (and the status each yields) are discoverable at the call site.
 */
import type { Statement } from "../statement.js";
import type { Value } from "../../values/value.js";
import type { Condition } from "../conditional.js";
import { generated } from "../generated/factories.generated.js";

/**
 * The exception a failed {@link precondition} raises, and the HTTP status the
 * runtime returns for it. Mirrors the engine's `mvp:precondition` `error_type`
 * enum ({@link https://github.com/sidestepai/core/issues/21 #21}):
 *
 * - `standard` — generic error (the default).
 * - `badrequest` — **400** Bad Request.
 * - `inputerror` — **400** Bad Request, tagged as input validation (the
 *   `payload` is attached as the offending param).
 * - `unauthorized` — **401** Unauthorized.
 * - `accessdenied` — **403** Forbidden.
 * - `notfound` — **404** Not Found.
 * - `toomanyrequests` — **429** Too Many Requests.
 */
export type PreconditionErrorType =
  | "standard"
  | "notfound"
  | "toomanyrequests"
  | "accessdenied"
  | "unauthorized"
  | "badrequest"
  | "inputerror";

export interface PreconditionArgs {
  /** The condition that must hold. When it evaluates falsy, the error is raised. */
  expr?: Condition;
  /**
   * Which status-bearing exception to raise on failure (default `standard`). Use
   * e.g. `badrequest` / `inputerror` to reject invalid input with a **400** a
   * client can detect via `res.ok` — unlike `s.throw`, which returns 200.
   */
  error_type?: PreconditionErrorType;
  /** The error message. */
  error?: Value;
  /** Extra payload attached to the error (for `inputerror`, the offending param). */
  payload?: Value;
}

/**
 * `precondition { … }` — assert a condition and raise a **status-bearing** error
 * if it fails (`mvp:precondition`). Prefer this over {@link throwError} (`s.throw`)
 * whenever the rejection must be observable via HTTP status — a client guarding
 * on `res.ok` sees a real 4xx instead of a 200 with an error body. See issue #21.
 *
 * @example
 * s.precondition({
 *   expr: fl.starts_with(input.url, "http"),
 *   error_type: "badrequest",
 *   error: c.text("url must start with http:// or https://"),
 * })
 */
export function precondition(a: PreconditionArgs = {}): Statement {
  return generated.precondition(a);
}

export interface ThrowArgs {
  /** Optional error name/code. */
  name?: string;
  /** The error value/message. */
  value: Value;
}

/**
 * `throw <value>` — raise an error from the stack (`mvp:throw_error`).
 *
 * ⚠️ The runtime returns a thrown error with **HTTP 200** and an error body, so
 * a client checking `res.ok` treats it as success. For a rejection that surfaces
 * as a real 4xx status, use {@link precondition} (`s.precondition`) with an
 * `error_type`. See issue #21.
 */
export function throwError(a: ThrowArgs): Statement {
  return generated.throw(a);
}
