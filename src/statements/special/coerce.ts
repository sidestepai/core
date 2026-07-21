/**
 * Shared typed-field plumbing for the hand-authored HTTP-request family
 * (`api.request`, `stream.from_request`, `webflow.request`, `microservice`).
 * Each of these has a generated bare-`Value` factory; the wrappers add ergonomic,
 * literal-friendly field types (each still accepting a dynamic {@link Value}) and
 * delegate encoding to the generated factory for byte-parity.
 *
 * Hoisted here per the rule of three once the second wrapper landed.
 */
import type { Value } from "../../values/value.js";
import { c } from "../../values/value.js";

/** The HTTP verbs the engine's runtime input schema accepts (suggested, not enforced). */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS" | "PATCH";

/** A tagged {@link Value} — the dynamic-binding escape hatch for any typed field. */
export function isValue(w: unknown): w is Value {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "tag" in w && "value" in w;
}

export const coerceText = (v: string | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.text(v);
export const coerceInt = (v: number | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.int(v);
export const coerceBool = (v: boolean | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.bool(v);
export const coerceObj = (v: object | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.obj(v as Record<string, unknown>);
export const coerceArray = (v: readonly string[] | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? v : c.array(v as string[]);

/** The shared TLS/HTTP fields carried by `api.request` / `stream.from_request` / `webflow.request`. */
export interface HttpRequestFields {
  method?: HttpMethod | (string & {}) | Value;
  params?: object | Value;
  headers?: readonly string[] | Value;
  timeout?: number | Value;
  follow_location?: boolean | Value;
  verify_host?: boolean | Value;
  verify_peer?: boolean | Value;
  ca_certificate?: string | Value;
  certificate?: string | Value;
  certificate_pass?: string | Value;
  private_key?: string | Value;
  private_key_pass?: string | Value;
}

/** Coerce the shared HTTP fields to their `Value` forms (undefined fields dropped downstream). */
export function coerceHttpFields(a: HttpRequestFields): Record<string, Value | undefined> {
  return {
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
  };
}

/** A field's statically-known emptiness: `"unknown"` for a dynamic `Value` we can't resolve. */
function textState(v: string | Value | undefined): "empty" | "nonempty" | "unknown" {
  if (v === undefined) return "empty"; // absent → engine's empty default
  if (typeof v === "string") return v === "" ? "empty" : "nonempty";
  if (isValue(v) && v.tag === "const") return v.value === "" ? "empty" : "nonempty";
  return "unknown"; // inp/ref/filtered — indeterminate at build time
}

function boolState(v: boolean | Value | undefined, engineDefault: boolean): "true" | "false" | "unknown" {
  if (v === undefined) return engineDefault ? "true" : "false";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isValue(v) && v.tag === "const:bool") return v.value === "true" ? "true" : "false";
  return "unknown";
}

/**
 * Enforce the engine's TLS/mTLS field interdependencies (`ApiRequest.php` /
 * `Api::fetch`) at build time — but ONLY when the combination is *statically
 * provable* invalid. A dynamic `Value` in any relevant field yields `"unknown"`
 * and is skipped, so this never rejects a workspace the engine would accept: it
 * is a strict superset of the engine's runtime checks, surfacing the same errors
 * earlier. The frontend does not block on these; the engine throws at runtime.
 */
export function assertSslConsistency(label: string, a: HttpRequestFields): void {
  const cert = textState(a.certificate);
  const key = textState(a.private_key);
  if (cert === "nonempty" && key === "empty")
    throw new Error(`${label}: \`certificate\` requires \`private_key\` — a client certificate needs its matching key.`);
  if (key === "nonempty" && cert === "empty")
    throw new Error(`${label}: \`private_key\` requires \`certificate\` — a client key needs its matching certificate.`);

  const ca = textState(a.ca_certificate);
  const verifyPeer = boolState(a.verify_peer, true);
  if (ca === "nonempty" && verifyPeer === "false")
    throw new Error(`${label}: \`ca_certificate\` requires \`verify_peer: true\` — the engine only consults a CA cert when peer verification is on.`);
}
