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
import { annotate } from "../statement.js";
import type { StatementAnnotations } from "../statement.js";
import { declaredServicePorts, type MicroserviceDef } from "../../kinds/microservice.js";
import {
  type HttpMethod,
  type HttpRequestFields,
  isValue,
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
 * The `{request, response}` envelope every external-request statement binds to
 * its `as` variable (`api.request`, `webflow.request`, `api.microservice`). Shape
 * confirmed against the Xano engine and a live run: `headers` are
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

export interface ApiRequestArgs extends HttpRequestFields, StatementAnnotations {
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
    disabled: a.disabled,
    description: a.description,
    output: a.output,
  }) as Statement & AsShapeBrand<As, ApiRequestResult>;
}

// ── stream.from_request ──────────────────────────────────────────────────────

export interface StreamFromRequestArgs extends HttpRequestFields, StatementAnnotations {
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
  return annotate(generated.stream.from_request({
    as: a.as,
    url: coerceText(a.url),
    ...coerceHttpFields(a),
  }), a);
}

// ── webflow.request ──────────────────────────────────────────────────────────

export interface WebflowRequestArgs extends HttpRequestFields, StatementAnnotations {
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
    disabled: a.disabled,
    description: a.description,
  }) as Statement & AsShapeBrand<As, ApiRequestResult>;
}

// ── api.microservice ─────────────────────────────────────────────────────────

/** Host spellings `s.api.microservice` accepts. */
export type MicroserviceHost = MicroserviceDef | string | Value;

/**
 * Resolve `host` + `port` to the single `name:port` text field the engine reads.
 *
 * The engine splits `host` on the first `:`, resolves the name portion against
 * the microservice row, and passes the port through into the request URL — so
 * `port` is an authoring convenience that folds back into one string here, and
 * never reaches the encoder. Everything this function can prove wrong, it
 * throws on: an authored statement that names a port its own microservice does
 * not expose would deploy clean and fail only at request time.
 */
function resolveMicroserviceHost(
  host: MicroserviceHost,
  port: number | string | undefined,
): string | Value {
  // Order matters: a `Value` and a `MicroserviceDef` are both objects, so the
  // tagged-Value test has to run first and be the explicit discriminator.
  if (isValue(host)) {
    if (port !== undefined) {
      throw new Error(
        "api.microservice: `port` cannot be joined onto a dynamic `host` at build time. " +
          "Build the joined `\"name:port\"` string in the value itself instead.",
      );
    }
    return host;
  }

  if (typeof host === "string") {
    if (port !== undefined && host.includes(":")) {
      throw new Error(
        `api.microservice: \`host\` already carries a port ("${host}"), so \`port: ${String(port)}\` is ambiguous. ` +
          "Pass the port once — either joined into `host` or as `port`.",
      );
    }
    return port === undefined ? host : `${host}:${port}`;
  }

  const declared = declaredServicePorts(host);

  if (port !== undefined) {
    // A microservice declaring no ports (helm, or a builtin exposing nothing)
    // has nothing to contradict, so any port is allowed through.
    if (declared.length > 0 && !declared.includes(String(port))) {
      throw new Error(
        `api.microservice: microservice "${host.name}" does not expose port ${String(port)}. ` +
          `It declares: ${declared.join(", ")}.`,
      );
    }
    return `${host.name}:${port}`;
  }

  // One declared port is unambiguous — it is the only entry the dashboard's own
  // host dropdown would offer for this microservice.
  if (declared.length === 1) return `${host.name}:${declared[0]}`;
  // No declared ports: the engine routes a bare name to `http://name/path`.
  if (declared.length === 0) return host.name;

  throw new Error(
    `api.microservice: microservice "${host.name}" declares ${declared.length} ports ` +
      `(${declared.join(", ")}), so \`port\` is required to pick one.`,
  );
}

/**
 * The literal `servicePort`s a def declares, at the type level — the type-side
 * mirror of {@link declaredServicePorts}.
 */
type PortsOf<D> = D extends { deployment: { containers: readonly (infer C)[] } }
  ? C extends { ports: readonly (infer P)[] }
    ? P extends { servicePort: infer S extends string }
      ? S
      : never
    : never
  : never;

/** `"8080"` → `8080`, so a port may be written as a number. */
type AsNumber<S extends string> = S extends `${infer N extends number}` ? N : never;

/**
 * What `port` accepts for a given `host`.
 *
 * Constrained to the declared ports ONLY when they are known as literals. Two
 * cases deliberately fall back to the open type rather than narrowing to
 * `never`, because a false type error on valid code is worse than a missing
 * one: a def whose ports widened to `string` (annotated `MicroserviceDef`,
 * built dynamically), and a def that declares no ports at all (helm).
 */
type PortArg<D> = string extends PortsOf<D>
  ? number | string
  : [PortsOf<D>] extends [never]
    ? number | string
    : PortsOf<D> | AsNumber<PortsOf<D>>;

export interface MicroserviceArgs<H extends MicroserviceHost = MicroserviceHost>
  extends StatementAnnotations {
  /** Capture the response into this stack variable. */
  as?: string;
  /**
   * Target microservice — the `microservice()` def to call.
   *
   * A plain string is also accepted, and is the only way to reach an
   * instance-level microservice (those live in instance settings, not the
   * workspace, so there is no def to pass). It carries its own port:
   * `"legacy:80"`.
   */
  host: H;
  /**
   * Port to call, folded into `host` as `name:port`.
   *
   * Optional: a microservice declaring exactly one `servicePort` resolves to it.
   * One declaring several requires this field, and rejects a port it does not
   * expose — as a TYPE error when the def's ports are known as literals, and as
   * a build-time throw otherwise. Serialized as text, matching how
   * `servicePort` is stored.
   */
  port?: H extends MicroserviceDef ? PortArg<H> : number | string;
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
 *
 * Address it by passing the `microservice()` def itself — its declared ports are
 * then checked at the authoring site, and a rename fixes every call site at once:
 *
 * ```ts
 * s.api.microservice({ host: echoService, path: "/health", ... })
 * ```
 *
 * `host` binds by NAME, not by guid — deliberately, because the engine resolves
 * this field by name too (a workspace-scoped lookup on the microservice's name).
 * A guid here would not be merely unconventional; it would be wrong.
 */
export function microservice<
  const As extends string = "",
  const H extends MicroserviceHost = MicroserviceHost,
>(
  a: MicroserviceArgs<H> & { as?: As },
): Statement & AsShapeBrand<As, ApiRequestResult> {
  return generated.api.microservice({
    as: a.as,
    host: coerceText(resolveMicroserviceHost(a.host, a.port))!,
    path: coerceText(a.path)!,
    method: coerceText(a.method)!,
    params: coerceObj(a.params)!,
    headers: coerceArray(a.headers)!,
    timeout: coerceInt(a.timeout)!,
    follow_location: coerceBool(a.follow_location)!,
    disabled: a.disabled,
    description: a.description,
  }) as Statement & AsShapeBrand<As, ApiRequestResult>;
}
