/**
 * Hand-authored typed wrappers for the HTTP-request statement family — the
 * "External API Request" (`api.request`) and its siblings `stream.from_request`,
 * `webflow.request`, and `microservice`. Each has a generated bare-`Value`
 * factory because the codegen source YAML types every field as generic
 * `!kinds assign`; the engine's *runtime* schema is stricter (method enum, int
 * timeout, object params, string-array headers, booleans) and the frontend
 * enforces that shape. These wrappers surface ergonomic, literal-friendly types
 * (each still accepting a dynamic {@link Value}) and delegate encoding to the
 * generated factory, so the emitted statement stays byte-identical to the
 * generated path. Shared coercion + TLS validation live in {@link ./coerce.ts}.
 *
 * TLS/mTLS field interdependencies are validated at build time only when the
 * combination is statically provable-invalid (see `assertSslConsistency`); a
 * dynamic `Value` is never rejected. `description` (Settings tab) and `output`
 * (Output tab) ride the envelope where the statement carries one — today only
 * `api.request` does (its siblings are lean specs).
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import type { Value } from "../../values/value.js";
import { generated } from "../generated/factories.generated.js";
import type { OutputAuthored } from "../schema-dsl/interpret.js";
import {
  type HttpMethod,
  type HttpRequestFields,
  coerceText,
  coerceObj,
  coerceArray,
  coerceInt,
  coerceBool,
  coerceHttpFields,
  assertSslConsistency,
} from "./coerce.js";

export type { HttpMethod };

/**
 * The `{request, response}` envelope every `Api::fetch`-backed statement binds to
 * its `as` variable (`api.request`, `webflow.request`, `api.microservice`). Shape
 * confirmed against the engine (`Api::fetch` in x2) and a live run: `headers` are
 * arrays of raw `"Name: value"` lines, `result` is the response body (JSON-decoded
 * when possible, else the raw string — hence `unknown`), `status` the HTTP code,
 * and `error` is present only on a transport-level (curl) failure.
 */
export interface ApiRequestResult {
  request: {
    url: string;
    method: string;
    headers: string[];
    params: unknown;
  };
  response: {
    headers: string[];
    result: unknown;
    status: number;
    error?: { code: number; message: string };
  };
}

// ── api.request ──────────────────────────────────────────────────────────────

export interface ApiRequestArgs extends HttpRequestFields {
  /** Capture the response (`{request, response}`) into this stack variable. */
  as?: string;
  /** Request URL. */
  url?: string | Value;
  /** Per-statement description (frontend "Settings" tab). */
  description?: string;
  /** Output-envelope shaping — result-variable filter chain / field mapping (frontend "Output" tab). */
  output?: OutputAuthored;
}

/**
 * `api.request` — issue an external HTTP request. Ergonomic, literal-friendly
 * field types over the generated `mvp:api_request` factory; delegates encoding
 * to it for byte-parity. Any field also accepts a dynamic {@link Value}.
 *
 * `method` suggests the 7 verbs, `params` is a key/value object (→ query string
 * for GET/HEAD/OPTIONS, body otherwise), `headers` an array of full header-line
 * strings, `timeout` seconds (engine bounds 1–86400), and the verify/follow
 * flags booleans. A plain-object `params` is a static `const:obj` (no nested
 * tagged values — issue #42); for dynamic params pass a `Value`.
 */
export function apiRequest<const As extends string = "">(
  a: ApiRequestArgs & { as?: As } = {},
): Statement & AsShapeBrand<As, ApiRequestResult> {
  assertSslConsistency("api.request", a);
  return generated.api.request({
    as: a.as,
    url: coerceText(a.url),
    ...coerceHttpFields(a),
    description: a.description,
    output: a.output,
  }) as Statement & AsShapeBrand<As, ApiRequestResult>;
}

// ── stream.from_request ──────────────────────────────────────────────────────

export interface StreamFromRequestArgs extends HttpRequestFields {
  /** Capture the streaming response into this stack variable. */
  as?: string;
  /** Request URL. */
  url?: string | Value;
}

/**
 * `stream.from_request` — stream an external HTTP request (`mvp:streaming_api_request`).
 * Same typed field surface as {@link apiRequest}; delegates to the generated factory.
 */
export function streamFromRequest(a: StreamFromRequestArgs = {}): Statement {
  assertSslConsistency("stream.from_request", a);
  return generated.stream.from_request({
    as: a.as,
    url: coerceText(a.url),
    ...coerceHttpFields(a),
  });
}

// ── webflow.request ──────────────────────────────────────────────────────────

export interface WebflowRequestArgs extends HttpRequestFields {
  /** Capture the response into this stack variable. */
  as?: string;
  /** Request path (relative to the Webflow API host). */
  path?: string | Value;
}

/**
 * `webflow.request` — call the Webflow API (`mvp:connect_webflow_api_request`).
 * Like {@link apiRequest} but addressed by `path` (the host is engine-supplied).
 */
export function webflowRequest<const As extends string = "">(
  a: WebflowRequestArgs & { as?: As } = {},
): Statement & AsShapeBrand<As, ApiRequestResult> {
  assertSslConsistency("webflow.request", a);
  return generated.webflow.request({
    as: a.as,
    path: coerceText(a.path),
    ...coerceHttpFields(a),
  }) as Statement & AsShapeBrand<As, ApiRequestResult>;
}

// ── api.microservice ─────────────────────────────────────────────────────────

export interface MicroserviceArgs {
  /** Capture the response into this stack variable. */
  as?: string;
  /** Target microservice host. */
  host: string | Value;
  /** Request path. */
  path: string | Value;
  /** HTTP verb — the 7 engine verbs are suggested; any string or dynamic `Value` is accepted. */
  method: HttpMethod | (string & {}) | Value;
  /** Request params — a key/value object. */
  params: object | Value;
  /** Headers — an array of full header-line strings. */
  headers: readonly string[] | Value;
  /** Request timeout in seconds. */
  timeout: number | Value;
  /** Follow HTTP redirects. */
  follow_location: boolean | Value;
}

/**
 * `api.microservice` — call an in-cluster microservice (`mvp:microservice_request`).
 * Typed over the generated factory; no TLS/cert fields (the engine schema omits
 * them). All request fields are required, matching the engine contract.
 */
export function microservice<const As extends string = "">(
  a: MicroserviceArgs & { as?: As },
): Statement & AsShapeBrand<As, ApiRequestResult> {
  return generated.api.microservice({
    as: a.as,
    host: coerceText(a.host)!,
    path: coerceText(a.path)!,
    method: coerceText(a.method)!,
    params: coerceObj(a.params)!,
    headers: coerceArray(a.headers)!,
    timeout: coerceInt(a.timeout)!,
    follow_location: coerceBool(a.follow_location)!,
  }) as Statement & AsShapeBrand<As, ApiRequestResult>;
}
