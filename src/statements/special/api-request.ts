/**
 * Hand-authored typed `api.request` (`mvp:api_request`, the "External API
 * Request" statement). The generated factory in `factories.generated.ts` types
 * every field as a bare `Value` because the codegen source YAML types them as
 * generic `!kinds assign`. The engine's *runtime* input schema is stricter
 * (method enum, int timeout, object params, string-array headers, booleans) and
 * the frontend editor enforces that shape — so this wrapper surfaces ergonomic,
 * literal-friendly types while still accepting a dynamic {@link Value} for any
 * field (matching `db.query`'s `number | Value` / `(string & {})` conventions).
 *
 * It does NOT re-encode `input[]` by hand — it coerces typed args to `Value`s
 * and delegates to the generated `api.request` factory, so the emitted statement
 * stays byte-identical to the generated path (proven by the api_request corpus
 * fixture). `description` (Settings tab) and `output` (Output tab) ride the
 * generated envelope surface added alongside this wrapper.
 *
 * SSL/mTLS field interdependencies (the engine requires `certificate` + `private_key`
 * together, and `ca_certificate` needs `verify_peer`) are NOT enforced here — the
 * frontend does not block on them either; the engine validates at runtime.
 */
import type { Statement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { c } from "../../values/value.js";
import { generated } from "../generated/factories.generated.js";
import type { OutputAuthored } from "../schema-dsl/interpret.js";

/** The HTTP verbs the engine's runtime input schema accepts (suggested, not enforced). */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS" | "PATCH";

/** A tagged {@link Value} — the dynamic-binding escape hatch for any typed field. */
function isValue(w: unknown): w is Value {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "tag" in w && "value" in w;
}

const coerceText = (v: string | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.text(v);
const coerceInt = (v: number | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.int(v);
const coerceBool = (v: boolean | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.bool(v);
const coerceObj = (v: object | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.obj(v as Record<string, unknown>);
const coerceArray = (v: readonly string[] | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.array(v as string[]);

export interface ApiRequestArgs {
  /** Capture the response (`{request, response}`) into this stack variable. */
  as?: string;
  /** Request URL. */
  url?: string | Value;
  /** HTTP verb — the 7 engine verbs are suggested; any string or dynamic `Value` is accepted. */
  method?: HttpMethod | (string & {}) | Value;
  /**
   * Request params — a key/value object (→ query string for GET/HEAD/OPTIONS,
   * body otherwise). A plain object is a static `const:obj` (no nested tagged
   * values — issue #42); for dynamic params pass a `Value` (e.g. a record of values).
   */
  params?: object | Value;
  /** Headers — an array of full header-line strings (`"Content-Type: application/json"`). */
  headers?: readonly string[] | Value;
  /** Request timeout in seconds (engine bounds: 1–86400; default 10). */
  timeout?: number | Value;
  /** Follow HTTP redirects (engine default true). */
  follow_location?: boolean | Value;
  /** Enforce the requested host matches the SSL certificate (engine default true). */
  verify_host?: boolean | Value;
  /** Enforce the SSL certificate is from a trusted authority (engine default true). */
  verify_peer?: boolean | Value;
  /** CA certificate (requires `verify_peer` at runtime). */
  ca_certificate?: string | Value;
  /** Client certificate (requires `private_key` at runtime). */
  certificate?: string | Value;
  /** Client-certificate passphrase. */
  certificate_pass?: string | Value;
  /** Client private key (requires `certificate` at runtime). */
  private_key?: string | Value;
  /** Client private-key passphrase. */
  private_key_pass?: string | Value;
  /** Per-statement description (frontend "Settings" tab). */
  description?: string;
  /** Output-envelope shaping — result-variable filter chain / field mapping (frontend "Output" tab). */
  output?: OutputAuthored;
}

/**
 * `api.request` — issue an external HTTP request. Ergonomic, literal-friendly
 * field types over the generated `mvp:api_request` factory; delegates encoding
 * to it for byte-parity. Any field also accepts a dynamic {@link Value}.
 */
export function apiRequest(a: ApiRequestArgs = {}): Statement {
  return generated.api.request({
    as: a.as,
    url: coerceText(a.url),
    method: coerceText(a.method),
    params: coerceObj(a.params),
    headers: coerceArray(a.headers),
    timeout: coerceInt(a.timeout),
    follow_location: coerceBool(a.follow_location),
    verify_host: coerceBool(a.verify_host),
    verify_peer: coerceBool(a.verify_peer),
    ca_certificate: coerceText(a.ca_certificate),
    certificate: coerceText(a.certificate),
    certificate_pass: coerceText(a.certificate_pass),
    private_key: coerceText(a.private_key),
    private_key_pass: coerceText(a.private_key_pass),
    description: a.description,
    output: a.output,
  });
}
