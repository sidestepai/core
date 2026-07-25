/**
 * Access-token lifecycle for the CLI. Owns the "produce a valid access token"
 * domain so command modules (today `push`, tomorrow anything else) don't each
 * re-implement the skew check, the discover→refresh dance, or — critically —
 * the server's refresh-token ROTATION invariant (`oauth.ts` `refresh`): the
 * refresh token you send is spent, and the returned one must be persisted.
 *
 * Node-only; keeps that invariant in exactly one place beside the token store.
 */
import lockfile from "proper-lockfile";
import type { ParsedArgs } from "../emit/cli.js";
import { OpenIdProvider, oauthErrorCode, decodeAudience, type RawTokens } from "./oauth.js";
import {
  readTokens,
  writeTokens,
  clearTokens,
  resolveAuthFilePath,
  globalAuthFilePath,
  localAuthFilePath,
  type TokenRecord,
} from "./store.js";
import { resolveAuthHost, resolveScope, assertHttpsOrigin } from "./config.js";
import { detail, warn, hostLabel } from "../emit/ui.js";

/** Refresh this many ms before the cached access token actually expires. */
const EXPIRY_SKEW_MS = 30_000;

/**
 * Cross-process lock options for the refresh+persist critical section. A second
 * concurrent `push` waits (retries) for the first to finish rather than racing
 * it — refresh tokens are single-use under rotation, so two simultaneous
 * refreshes would spend the same token and clobber each other's write.
 */
const REFRESH_LOCK_OPTS = {
  retries: { retries: 30, factor: 1.3, minTimeout: 50, maxTimeout: 500 },
  stale: 20_000,
};

/** A usable access token plus the instance it authorizes against. */
export interface ResolvedAuth {
  access_token: string;
  /** Instance origin the token is bound to (also the push URL host). */
  instance: string;
}

/** Stamp an absolute `expires_at` onto a token-endpoint response (mirrors what the old hand-rolled `postToken` did). */
function stampExpiry(raw: RawTokens): { access_token: string; refresh_token?: string; scope?: string; expires_at: number } {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    scope: raw.scope,
    expires_at: Date.now() + (raw.expires_in ?? 0) * 1000,
  };
}

/**
 * Run a refresh-grant exchange for the client that minted the token. The AS
 * ROTATES the refresh token, so the caller MUST persist the returned one. No
 * `resource` is sent — the new token is bound to the instance the refresh token
 * was already minted for (read it back from the token's `aud`).
 */
function refreshAccessToken(
  authHost: string,
  clientId: string,
  refreshToken: string,
  scope: string | undefined,
): Promise<RawTokens> {
  const provider = new OpenIdProvider({ authHost, scope: scope ?? "", clientId });
  return provider.refresh(refreshToken, { scope });
}

/**
 * A refresh failure that carries no OAuth error code is a transport-level blip
 * (DNS/connection reset/timeout — a bare `fetch failed`), not a credential
 * problem. The AS never got to reject anything, so `sidestep login` is the wrong
 * remedy: re-running the deploy usually just works. An OAuth error response
 * (`invalid_grant`, `invalid_client`, …) is deterministic and IS auth-related.
 */
export function isTransientRefreshError(err: unknown): boolean {
  return oauthErrorCode(err) === undefined;
}

/**
 * Refresh the access token, retrying once on a transient network failure. An
 * OAuth error response is deterministic and never retried — a second attempt
 * would only re-reject. If the retry hits `invalid_grant` (e.g. the first
 * attempt actually rotated the token server-side before the response was lost),
 * the caller's `invalid_grant` branch handles it correctly.
 */
async function refreshWithRetry(
  authHost: string,
  clientId: string,
  refreshToken: string,
  scope: string | undefined,
): Promise<RawTokens> {
  try {
    return await refreshAccessToken(authHost, clientId, refreshToken, scope);
  } catch (err) {
    if (!isTransientRefreshError(err)) throw err;
    detail(`Token refresh hit a network error; retrying once…`);
    return await refreshAccessToken(authHost, clientId, refreshToken, scope);
  }
}

/**
 * Resolve an OAuth access token and the target instance. The instance is always
 * the one the token is bound to — chosen at consent during `login`, never a
 * flag.
 *
 * CI path: `XANO_REFRESH_TOKEN` set → exchange it; the target instance is read
 * back from the fresh token's `aud`. Nothing is read from or written to disk.
 * Interactive path: read the `login` token cache, refreshing + persisting the
 * rotated refresh token when the cached access token is stale.
 */
export async function getAccessToken(args: ParsedArgs): Promise<ResolvedAuth> {
  const envRefresh = process.env.XANO_REFRESH_TOKEN;

  if (envRefresh) {
    const authHost = resolveAuthHost(args);
    assertHttpsOrigin(authHost, "--origin");
    const clientId = process.env.XANO_CLIENT_ID;
    if (!clientId) {
      throw new Error(
        `XANO_REFRESH_TOKEN is set but XANO_CLIENT_ID is not. A refresh token can only be ` +
          `exchanged by the client that minted it — copy both values from \`.xano/auth.json\` ` +
          `(fields "refresh_token" and "client_id") after \`sidestep login\`.`,
      );
    }
    let set: RawTokens;
    try {
      set = await refreshAccessToken(authHost, clientId, envRefresh, resolveScope(args));
    } catch (err) {
      throw new Error(
        `XANO_REFRESH_TOKEN exchange failed: ${err instanceof Error ? err.message : String(err)}\n` +
          `The refresh token may be expired or already spent — refresh tokens rotate on use, so a ` +
          `single stored value is consumed on first exchange. Mint a fresh one via \`sidestep login\`.`,
      );
    }
    // The target instance is whatever the refresh token is bound to.
    const instance = decodeAudience(set.access_token);
    if (!instance) {
      throw new Error(
        `Could not determine the target instance from the token minted by XANO_REFRESH_TOKEN ` +
          `(no readable \`aud\` claim). Mint a fresh refresh token via \`sidestep login\`.`,
      );
    }
    assertHttpsOrigin(instance, "instance");
    return { access_token: set.access_token, instance };
  }

  const authFilePath = resolveAuthFilePath(args);
  const saved = readTokens(authFilePath);
  if (!saved) {
    throw new Error(
      `Not signed in (no token cache at ${authFilePath}). ` +
        `Run \`sidestep login\` first, or set XANO_REFRESH_TOKEN for CI.`,
    );
  }

  warnIfLocalShadowsGlobal(args, authFilePath, saved);

  const instance = saved.instance;
  assertHttpsOrigin(instance, "instance");

  if (Date.now() < saved.expires_at - EXPIRY_SKEW_MS) {
    return { access_token: saved.access_token, instance };
  }

  return refreshUnderLock(authFilePath, saved);
}

/**
 * Loud guard against a stale project-local cache silently shadowing the global
 * default. Pre-4.1.0 releases wrote `./.xano/auth.json` by default, so an old
 * project dir can still hold a leftover local cache; read mode prefers it over
 * the global one, which — if the two are bound to DIFFERENT instances — would
 * point a full-replace deploy at the wrong instance with no visible sign.
 *
 * Only fires for the *default* resolution (no `--config`/`$XANO_CONFIG`, no
 * `--local`) that landed on the local cache while a divergent global cache also
 * exists. An explicit path or `--local` is a deliberate choice and stays quiet.
 */
function warnIfLocalShadowsGlobal(args: ParsedArgs, resolved: string, saved: TokenRecord): void {
  const isDefaultResolution = args.authFile === undefined && process.env.XANO_CONFIG === undefined && !args.local;
  if (!isDefaultResolution || resolved !== localAuthFilePath()) return;
  const globalPath = globalAuthFilePath();
  if (globalPath === resolved) return;
  const globalSaved = readTokens(globalPath);
  if (globalSaved && globalSaved.instance !== saved.instance) {
    warn(
      `Using project-local ${resolved} (bound to ${hostLabel(saved.instance)}), but a global ` +
        `cache bound to ${hostLabel(globalSaved.instance)} also exists — the local cache wins. ` +
        `Remove ./.xano/auth.json (or pass --config) to use the global credential instead.`,
    );
  }
}

/**
 * Refresh + persist the token cache while holding a cross-process advisory lock.
 * After acquiring the lock we RE-READ the cache: if a concurrent `push`
 * refreshed while we waited, we use its result instead of spending our
 * now-stale refresh token a second time.
 */
async function refreshUnderLock(authFilePath: string, saved: TokenRecord): Promise<ResolvedAuth> {
  const release = await lockfile.lock(authFilePath, REFRESH_LOCK_OPTS);
  try {
    const current = readTokens(authFilePath) ?? saved;
    const instance = current.instance;
    if (Date.now() < current.expires_at - EXPIRY_SKEW_MS) {
      return { access_token: current.access_token, instance };
    }
    if (!current.refresh_token) {
      throw new Error(
        `No usable access token for ${instance} and no refresh token is cached. ` +
          `Run \`sidestep login\` again.`,
      );
    }
    detail(`Refreshing access token for ${hostLabel(instance)}…`);
    let set: RawTokens;
    try {
      set = await refreshWithRetry(current.auth_host, current.client_id, current.refresh_token, current.scope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A rejected/replayed/expired refresh token can't be salvaged: drop the
      // spent credentials so the next run starts a clean login rather than
      // retrying with a token the AS will keep rejecting.
      if (oauthErrorCode(err) === "invalid_grant") {
        clearTokens(authFilePath);
        throw new Error(
          `Session for ${instance} has expired or was revoked (the refresh token was rejected). ` +
            `Run \`sidestep login\` to sign in again.`,
        );
      }
      // A transient network failure (bare `fetch failed`, timeout) reached no
      // authorization server, so `sidestep login` is the wrong fix — and the one
      // command automated agents are told not to run. Point at a retry instead.
      if (isTransientRefreshError(err)) {
        throw new Error(
          `Token refresh for ${instance} could not reach the authorization server (${message}), even after one retry. ` +
            `This is a transient network error, not an auth problem — re-run the deploy. ` +
            `If it persists, check connectivity to ${current.auth_host}.`,
        );
      }
      // A genuine OAuth error (invalid_client, etc.) — credentials/config are at
      // fault, so re-authenticating is the right remedy.
      throw new Error(
        `Token refresh failed for ${instance}: ${message}\n` + `Run \`sidestep login\` to sign in again.`,
      );
    }
    const stamped = stampExpiry(set);
    // Persist the rotated refresh token — the old one is now spent.
    writeTokens(authFilePath, {
      ...current,
      access_token: stamped.access_token,
      refresh_token: stamped.refresh_token ?? current.refresh_token,
      expires_at: stamped.expires_at,
      scope: stamped.scope ?? current.scope,
    });
    return { access_token: stamped.access_token, instance };
  } finally {
    await release();
  }
}
