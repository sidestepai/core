/**
 * OAuth 2.1 primitives for the CLI's login/push flows, targeting the
 * cloud-master control-plane authorization server. Pure and HTTP-only — PKCE
 * generation plus `fetch` calls to the discovery, token, and refresh endpoints;
 * no file, server, or browser I/O (those live in `store.ts`/`loopback.ts`). This
 * is the easily unit-testable heart of the flow.
 *
 * Node-only (uses `node:crypto`). The repo's `util/hash.ts` reimplements hashes
 * over Web Crypto because they must run in a frontend bundle — that constraint
 * does NOT apply here, so `node:crypto` is the correct, idiomatic choice for
 * PKCE. Do not move this crypto into `util/hash.ts`.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * The loopback path the callback server listens on and the client registers as
 * its redirect target. Combined with a FIXED port (see DEFAULT_PORT) this makes
 * the `redirect_uri` deterministic, so a Dynamic Client Registration can record
 * it exactly and the authorize server's exact-match check always passes.
 */
export const CALLBACK_PATH = "/oauth/callback";

/**
 * Fixed loopback port for the callback. Unlike an ephemeral port, a fixed value
 * lets the DCR redirect_uri be registered exactly (RFC 8252 loopback-port
 * flexibility is not relied upon). Overridable via `--port`; a re-registration
 * happens automatically when the resulting redirect_uri changes.
 */
export const DEFAULT_PORT = 47100;

/** RFC 7591 `software_id` for the CLI's dynamically-registered client. */
export const SOFTWARE_ID = "sidestep";

/** Default cloud-master OAuth host when none is configured. */
export const DEFAULT_AUTH_HOST = "https://app.xano.com";

/**
 * Scopes requested by default. `offline_access` is what yields the refresh
 * token push relies on; `workspace:write`/`xano:dev` cover the sandbox import.
 * No `openid` — identity/instance binding is read from the token's `aud` claim
 * (see `decodeAudience`), not an id_token.
 */
export const DEFAULT_SCOPE = "offline_access workspace:read workspace:write xano:dev";

/** Well-known discovery path (served at the bare auth-host origin). */
const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

/** Bound every OAuth HTTP call so a stalled endpoint can't hang the CLI/CI forever. */
const NETWORK_TIMEOUT_MS = 30_000;

/** The OAuth endpoints the CLI drives, resolved from discovery. */
export interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  /** RFC 7591 Dynamic Client Registration endpoint (may be absent). */
  registration_endpoint?: string;
}

/** A PKCE verifier/challenge pair (S256). */
export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Normalized token-endpoint response, with an absolute expiry stamped on. */
export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  /** Epoch milliseconds after which `access_token` is no longer valid. */
  expires_at: number;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Generate a PKCE verifier and its S256 challenge. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** A high-entropy `state` value for CSRF protection on the authorize round-trip. */
export function randomState(): string {
  return base64url(randomBytes(16));
}

/** Fetch and validate the authorization-server metadata for `authHost`. */
export async function discover(authHost: string): Promise<Endpoints> {
  const url = new URL(DISCOVERY_PATH, authHost).href;
  const res = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(
      `OAuth discovery failed (${res.status} ${res.statusText}) at ${url}. ` +
        `Check --auth-host (currently ${authHost}).`,
    );
  }
  const doc = (await res.json()) as Partial<Endpoints>;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(`OAuth discovery doc at ${url} is missing authorization/token endpoints.`);
  }
  return {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    registration_endpoint: doc.registration_endpoint,
  };
}

/**
 * Dynamically register a public CLI client (RFC 7591) whose redirect URI is
 * EXACTLY the loopback callback we will use, so the authorize server's
 * exact-match check passes without relying on loopback-port normalization.
 *
 * Two Xano-specific quirks (mirroring sidestep-dashboard's registrar): the server
 * answers 200 (not RFC 7591's 201), and it reads a `scopes` ARRAY rather than a
 * space-separated `scope` string.
 */
export async function registerClient(params: {
  registrationEndpoint: string;
  redirectUri: string;
  scope: string;
}): Promise<{ client_id: string }> {
  const res = await fetch(params.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "sidestep CLI",
      software_id: SOFTWARE_ID,
      redirect_uris: [params.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scopes: params.scope.split(/\s+/).filter(Boolean),
    }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Client registration failed (${res.status} ${res.statusText}):\n${text}`);
  }
  const doc = JSON.parse(text) as { client_id?: string };
  if (!doc.client_id) {
    throw new Error(`Client registration response had no client_id:\n${text}`);
  }
  return { client_id: doc.client_id };
}

/**
 * Read the instance origin a token is bound to from its `aud` claim (RFC 9068
 * at+jwt). Decodes the payload only — the instance meta API is the verifier of
 * record — and returns the audience, or undefined if it can't be read.
 */
export function decodeAudience(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      aud?: string | string[];
    };
    return Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  } catch {
    return undefined;
  }
}

/** Parameters for the authorize redirect. */
export interface AuthorizeUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  /** Optional RFC 8707 `resource` to pre-select the target instance. When
   *  omitted, the user chooses the instance at the hosted consent screen and the
   *  binding is read back from the token's `aud` claim. */
  instance?: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

/** Build the browser authorize URL (authorization-code + PKCE, S256). */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL(p.authorizationEndpoint);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (p.instance) url.searchParams.set("resource", p.instance);
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", p.state);
  return url.href;
}

/** Raw token-endpoint payload before we stamp `expires_at`. */
interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(tokenEndpoint: string, body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: RawTokenResponse;
  try {
    json = JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new Error(`Token endpoint returned non-JSON (${res.status} ${res.statusText}):\n${text}`);
  }
  if (!res.ok || !json.access_token) {
    const detail = json.error ? `${json.error}${json.error_description ? `: ${json.error_description}` : ""}` : text;
    throw new Error(`Token request failed (${res.status} ${res.statusText}): ${detail}`);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    scope: json.scope,
    expires_at: Date.now() + (json.expires_in ?? 0) * 1000,
  };
}

/** Parameters for the authorization-code exchange. */
export interface ExchangeCodeParams {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** Optional `resource`; must match the authorize request when it was sent. */
  instance?: string;
}

/** Exchange an authorization code (+ PKCE verifier) for a token set. */
export function exchangeCode(p: ExchangeCodeParams): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    code_verifier: p.codeVerifier,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
  });
  if (p.instance) body.set("resource", p.instance);
  return postToken(p.tokenEndpoint, body);
}

/** Parameters for a refresh-token exchange. */
export interface RefreshParams {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  /** Optional `resource` — the instance the fresh token should be bound to. */
  instance?: string;
  scope?: string;
}

/**
 * Exchange a refresh token for a fresh access token. The server ROTATES the
 * refresh token on every call, so callers MUST persist the returned
 * `refresh_token` — the one passed in is now spent.
 */
export function refresh(p: RefreshParams): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: p.refreshToken,
    client_id: p.clientId,
  });
  if (p.instance) body.set("resource", p.instance);
  if (p.scope) body.set("scope", p.scope);
  return postToken(p.tokenEndpoint, body);
}
