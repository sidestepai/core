/**
 * OAuth 2.1 protocol layer for the CLI's login/push/logout flows, targeting the
 * cloud-master control-plane authorization server. Backed by `openid-client`
 * (OpenID-certified) — the same library the sidestep dashboard's BFF uses — so
 * the two share one battle-tested implementation of RFC 8414 discovery, PKCE,
 * the authorization-code grant, refresh (with rotation), and revocation.
 *
 * The CLI differs from the dashboard in three ways, all handled here:
 *   - the redirect target is a loopback URL with a runtime-bound port (see
 *     `loopback.ts`), not a fixed config value;
 *   - the DCR client registration is cached per (auth host + redirect URI) in a
 *     global machine file (`client-store.ts`), reused across projects;
 *   - it pins the target instance via RFC 8707 `resource` (the dashboard lets
 *     the user pick at consent). `resource` is passed through on authorize,
 *     code-exchange, and refresh.
 *
 * `discover`, `registerClient`, and `decodeAudience` stay as pure/HTTP-only
 * helpers (fetch + decode, no openid-client) because they're both trivially
 * unit-testable and needed before a `Configuration` exists. Node-only; never
 * reachable from the browser-safe `index.ts` surface.
 */
import * as client from "openid-client";
import { getOrRegisterClient, clearClient } from "./client-store.js";

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

/** The OAuth endpoints resolved from discovery (for the DCR pre-step). */
export interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  /** RFC 7591 Dynamic Client Registration endpoint (may be absent). */
  registration_endpoint?: string;
}

/**
 * The token-endpoint response as openid-client surfaces it, before we stamp an
 * absolute `expires_at` (that happens in `token.ts`/`login-command.ts`, where an
 * injectable clock lives).
 */
export interface RawTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
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
 * Two Xano-specific quirks (mirroring sidestep-dashboard's registrar, and the
 * reason we POST directly rather than via openid-client): the server answers 200
 * (not RFC 7591's 201), and it reads a `scopes` ARRAY rather than a
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

/** Extract the OAuth error code from an openid-client error, if present. */
export function oauthErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "error" in err) {
    const code = (err as { error?: unknown }).error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Options shared by every `resource`-carrying request. */
interface ResourceOpts {
  /** RFC 8707 `resource` — the instance the token should be bound to. */
  instance?: string;
  scope?: string;
}

/**
 * The protocol surface the CLI commands drive. Fakeable in tests (as in the
 * dashboard) so callers can be exercised without a live authorization server.
 */
export interface TokenProvider {
  /** Build the browser authorize URL (authorization-code + PKCE, S256). */
  buildAuthUrl(p: { verifier: string; state: string; instance?: string }): Promise<string>;
  /** Exchange the loopback callback URL for a token set. */
  exchange(callbackUrl: string, p: { verifier: string; state: string; instance?: string }): Promise<RawTokens>;
  /** Refresh — the server ROTATES the refresh token, so persist the new one. */
  refresh(refreshToken: string, opts?: ResourceOpts): Promise<RawTokens>;
  /** Revoke the refresh token at the AS (logout). */
  revoke(refreshToken: string): Promise<void>;
  /** Drop the cached config + DCR registration (e.g. after `invalid_client`). */
  reset(): Promise<void>;
}

export interface OpenIdProviderOptions {
  authHost: string;
  /** Loopback redirect URI — required for authorize/exchange, unused for refresh/revoke. */
  redirectUri?: string;
  scope: string;
  /**
   * A pre-known `client_id` (the refresh/logout paths read it from the token
   * cache). When set, discovery skips DCR entirely — we already have a client.
   */
  clientId?: string;
}

/**
 * openid-client-backed provider. Lazily builds (and memoizes) a `Configuration`
 * — discovery + a DCR registration when no `client_id` is known — then delegates
 * PKCE, the code grant, refresh, and revocation to openid-client.
 */
export class OpenIdProvider implements TokenProvider {
  private configPromise?: Promise<client.Configuration>;
  /** The client_id the resolved config uses — set once `build()` completes. */
  private resolvedClientId?: string;

  constructor(private readonly opts: OpenIdProviderOptions) {}

  private redirectUri(): string {
    if (!this.opts.redirectUri) {
      throw new Error("OpenIdProvider: redirectUri is required for the authorize/exchange flow.");
    }
    return this.opts.redirectUri;
  }

  /**
   * The client_id this provider registered or reused. Only valid after the
   * config has resolved (e.g. after `buildAuthUrl`/`exchange`); throws otherwise
   * so a caller never records an empty client_id.
   */
  clientId(): string {
    if (!this.resolvedClientId) {
      throw new Error("OpenIdProvider.clientId() called before the configuration was resolved.");
    }
    return this.resolvedClientId;
  }

  private async build(): Promise<client.Configuration> {
    const server = new URL(this.opts.authHost);
    // Allow plain-HTTP only when the target itself is http (local cloud-master).
    const options =
      server.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;

    let clientId = this.opts.clientId;
    if (!clientId) {
      const { registration_endpoint } = await discover(this.opts.authHost);
      if (!registration_endpoint) {
        throw new Error(
          `The OAuth server at ${this.opts.authHost} does not advertise a registration ` +
            `endpoint, so sidestep can't register its loopback client. Check --auth-host.`,
        );
      }
      clientId = await getOrRegisterClient({
        authHost: this.opts.authHost,
        redirectUri: this.redirectUri(),
        registrationEndpoint: registration_endpoint,
        scope: this.opts.scope,
      });
    }
    this.resolvedClientId = clientId;
    return client.discovery(
      server,
      clientId,
      { token_endpoint_auth_method: "none" },
      client.None(),
      options,
    );
  }

  private config(): Promise<client.Configuration> {
    return (this.configPromise ??= this.build());
  }

  async reset(): Promise<void> {
    this.configPromise = undefined;
    this.resolvedClientId = undefined;
    if (this.opts.redirectUri) {
      clearClient({ authHost: this.opts.authHost, redirectUri: this.opts.redirectUri });
    }
  }

  async buildAuthUrl({
    verifier,
    state,
    instance,
  }: {
    verifier: string;
    state: string;
    instance?: string;
  }): Promise<string> {
    const config = await this.config();
    const code_challenge = await client.calculatePKCECodeChallenge(verifier);
    const params: Record<string, string> = {
      redirect_uri: this.redirectUri(),
      scope: this.opts.scope,
      code_challenge,
      code_challenge_method: "S256",
      state,
    };
    if (instance) params.resource = instance;
    return client.buildAuthorizationUrl(config, params).href;
  }

  async exchange(
    callbackUrl: string,
    { verifier, state, instance }: { verifier: string; state: string; instance?: string },
  ): Promise<RawTokens> {
    const config = await this.config();
    const tokens = await client.authorizationCodeGrant(
      config,
      new URL(callbackUrl),
      // We don't request `openid`, so no ID Token is expected.
      { pkceCodeVerifier: verifier, expectedState: state, idTokenExpected: false },
      instance ? { resource: instance } : undefined,
    );
    return pick(tokens);
  }

  async refresh(refreshToken: string, opts?: ResourceOpts): Promise<RawTokens> {
    const config = await this.config();
    const params: Record<string, string> = {};
    if (opts?.instance) params.resource = opts.instance;
    if (opts?.scope) params.scope = opts.scope;
    return pick(await client.refreshTokenGrant(config, refreshToken, params));
  }

  async revoke(refreshToken: string): Promise<void> {
    const config = await this.config();
    await client.tokenRevocation(config, refreshToken, { token_type_hint: "refresh_token" });
  }
}

function pick(t: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): RawTokens {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: t.expires_in,
    scope: t.scope,
  };
}
