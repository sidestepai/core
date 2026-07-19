/**
 * Node-only sandbox impersonation: exchange the caller's token for credentials
 * scoped to their singleton sandbox tenant.
 *
 * The sandbox has no static-host endpoints of its own — `sandbox/bundle` imports
 * a backend bundle and nothing more. To reach the ordinary static-host routes
 * (`/api:meta/workspace/{id}/static_host/...`) against the sandbox rather than
 * the caller's own workspace, we go through the two-step impersonation hop the
 * frontend uses:
 *
 *   1. `GET  /api:meta/sandbox/impersonate`     -> `{ _ti }`, a one-time token
 *   2. `POST /api:meta/tenant/token/exchange`   -> `{ _authToken, baseUrl, headers }`
 *
 * For a tier1 tenant (which the sandbox always is) the exchange does NOT mint a
 * new origin or a different bearer: `_authToken` is the caller's own token and
 * `baseUrl` is the same instance. The thing that actually redirects the request
 * into the sandbox is the returned **`X-Tenant` header**. So callers must send
 * `headers` verbatim on every impersonated request — dropping them silently
 * targets the caller's real workspace instead, which is the dangerous failure
 * mode this module exists to prevent.
 *
 * The `_ti` is single-use: each impersonated deploy performs its own hop.
 *
 * Lazily imported by the command layer so the browser-safe authoring bundle
 * never pulls this Node-only transport in.
 */
import type { ResolvedAuth } from "../auth/token.js";

const IMPERSONATE_TIMEOUT_MS = 30_000;

/** Credentials for talking to the sandbox tenant through the ordinary meta API. */
export interface SandboxCreds {
  /** Bearer token to send. For tier1 this is the caller's own token. */
  accessToken: string;
  /** Origin to resolve meta-API paths against. */
  baseUrl: string;
  /**
   * Tenant-routing headers (`X-Tenant`). MUST be sent on every impersonated
   * request — without them the request hits the caller's own workspace.
   */
  headers: Record<string, string>;
  /** The sandbox tenant's name, for display. */
  name: string | undefined;
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${what} failed (${res.status} ${res.statusText}):\n${text}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${what}: could not parse the response as JSON:\n${text}`);
  }
}

/**
 * Run the impersonation hop and return credentials scoped to the caller's
 * sandbox tenant. Throws with an actionable message if either leg fails or the
 * exchange omits the tenant-routing headers.
 */
export async function impersonateSandbox(auth: ResolvedAuth): Promise<SandboxCreds> {
  const ottRes = await fetch(new URL("/api:meta/sandbox/impersonate", auth.instance).href, {
    headers: { Authorization: `Bearer ${auth.access_token}` },
    signal: AbortSignal.timeout(IMPERSONATE_TIMEOUT_MS),
  });
  const ott = await readJson(ottRes, "sandbox impersonate");
  const ticket = ott._ti;
  if (typeof ticket !== "string" || ticket === "") {
    throw new Error(`sandbox impersonate: response carried no \`_ti\` one-time token.`);
  }

  const exchangeRes = await fetch(new URL("/api:meta/tenant/token/exchange", auth.instance).href, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: ticket }),
    signal: AbortSignal.timeout(IMPERSONATE_TIMEOUT_MS),
  });
  const creds = await readJson(exchangeRes, "sandbox token exchange");

  const accessToken = typeof creds._authToken === "string" ? creds._authToken : undefined;
  if (accessToken === undefined || accessToken === "") {
    throw new Error(`sandbox token exchange: response carried no \`_authToken\`.`);
  }
  const baseUrl = typeof creds.baseUrl === "string" && creds.baseUrl !== "" ? creds.baseUrl : auth.instance;

  // The X-Tenant header IS the impersonation for tier1. Its absence would mean
  // every subsequent call quietly lands on the caller's real workspace, so treat
  // a headerless exchange as a hard failure rather than deploying to the wrong place.
  const rawHeaders = creds.headers;
  const headers: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") headers[k] = v;
    }
  }
  if (Object.keys(headers).length === 0) {
    throw new Error(
      `sandbox token exchange: response carried no tenant-routing headers (expected \`X-Tenant\`). ` +
        `Refusing to continue — without them the upload would target your real workspace.`,
    );
  }

  return {
    accessToken,
    baseUrl,
    headers,
    name: typeof creds.name === "string" ? creds.name : undefined,
  };
}
