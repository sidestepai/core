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
import { discover, refresh, type TokenSet } from "./oauth.js";
import { readTokens, writeTokens, resolveAuthFilePath, type TokenRecord } from "./store.js";
import { resolveInstance, resolveAuthHost, resolveScope, assertHttpsOrigin } from "./config.js";

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

/** Compare two instance origins for token-audience purposes (trailing slash insensitive). */
function sameInstance(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** A usable access token plus the instance it authorizes against. */
export interface ResolvedAuth {
  access_token: string;
  /** Instance origin the token is bound to (also the push URL host). */
  instance: string;
}

/** Discover the token endpoint for `authHost` and run a refresh-grant exchange. */
function refreshAccessToken(
  authHost: string,
  clientId: string,
  refreshToken: string,
  instance: string,
  scope: string | undefined,
): Promise<TokenSet> {
  return discover(authHost).then(({ token_endpoint }) =>
    refresh({ tokenEndpoint: token_endpoint, clientId, refreshToken, instance, scope }),
  );
}

/**
 * Resolve an OAuth access token and the target instance.
 *
 * CI path: `XANO_REFRESH_TOKEN` set → exchange it (needs an explicit
 * --instance/$XANO_INSTANCE); nothing is read from or written to disk.
 * Interactive path: read the `login` token cache, refreshing + persisting the
 * rotated refresh token when the cached access token is stale.
 */
export async function getAccessToken(args: ParsedArgs): Promise<ResolvedAuth> {
  const envRefresh = process.env.XANO_REFRESH_TOKEN;

  if (envRefresh) {
    const instance = resolveInstance(args);
    if (!instance) {
      throw new Error(
        `XANO_REFRESH_TOKEN is set but no target instance was given. ` +
          `Pass --instance <origin> (or set $XANO_INSTANCE).`,
      );
    }
    const authHost = resolveAuthHost(args);
    assertHttpsOrigin(instance, "--instance");
    assertHttpsOrigin(authHost, "--auth-host");
    const clientId = process.env.XANO_CLIENT_ID;
    if (!clientId) {
      throw new Error(
        `XANO_REFRESH_TOKEN is set but XANO_CLIENT_ID is not. A refresh token can only be ` +
          `exchanged by the client that minted it — copy both values from \`.xano/auth.json\` ` +
          `(fields "refresh_token" and "client_id") after \`sidestep login\`.`,
      );
    }
    let set: TokenSet;
    try {
      set = await refreshAccessToken(authHost, clientId, envRefresh, instance, resolveScope(args));
    } catch (err) {
      throw new Error(
        `XANO_REFRESH_TOKEN exchange failed for ${instance}: ${err instanceof Error ? err.message : String(err)}\n` +
          `The refresh token may be expired or already spent — refresh tokens rotate on use, so a ` +
          `single stored value is consumed on first exchange. Mint a fresh one via \`sidestep login\`.`,
      );
    }
    return { access_token: set.access_token, instance };
  }

  const authFilePath = resolveAuthFilePath(args);
  const saved = readTokens(authFilePath);
  if (!saved) {
    throw new Error(
      `Not signed in (no token cache at ${authFilePath}). ` +
        `Run \`sidestep login --instance <origin>\` first, or set XANO_REFRESH_TOKEN for CI.`,
    );
  }

  const instance = resolveInstance(args, saved.instance)!;
  assertHttpsOrigin(instance, "instance");

  // Reuse the cached access token only when it is both fresh AND minted for the
  // instance we're targeting. A cached token's audience is `saved.instance`; if
  // --instance/$XANO_INSTANCE overrides to a different origin, reusing it would
  // send an A-audience bearer token to origin B (a 401/403 at best, a token
  // leak to the wrong host at worst). On mismatch, fall through to re-mint a
  // token for the new audience.
  if (sameInstance(instance, saved.instance) && Date.now() < saved.expires_at - EXPIRY_SKEW_MS) {
    return { access_token: saved.access_token, instance };
  }

  return refreshUnderLock(authFilePath, saved, instance);
}

/**
 * Refresh + persist the token cache while holding a cross-process advisory lock.
 * After acquiring the lock we RE-READ the cache: if a concurrent `push`
 * refreshed while we waited, we use its result instead of spending our
 * now-stale refresh token a second time.
 */
async function refreshUnderLock(
  authFilePath: string,
  saved: TokenRecord,
  instance: string,
): Promise<ResolvedAuth> {
  const release = await lockfile.lock(authFilePath, REFRESH_LOCK_OPTS);
  try {
    const current = readTokens(authFilePath) ?? saved;
    if (sameInstance(instance, current.instance) && Date.now() < current.expires_at - EXPIRY_SKEW_MS) {
      return { access_token: current.access_token, instance };
    }
    if (!current.refresh_token) {
      throw new Error(
        `No usable access token for ${instance} and no refresh token is cached. ` +
          `Run \`sidestep login --instance ${instance}\` again.`,
      );
    }
    process.stderr.write(`Refreshing access token for ${instance}…\n`);
    let set: TokenSet;
    try {
      set = await refreshAccessToken(current.auth_host, current.client_id, current.refresh_token, instance, current.scope);
    } catch (err) {
      throw new Error(
        `Token refresh failed for ${instance}: ${err instanceof Error ? err.message : String(err)}\n` +
          `Run \`sidestep login --instance ${instance}\` to sign in again.`,
      );
    }
    // Persist the rotated refresh token — the old one is now spent.
    writeTokens(authFilePath, {
      ...current,
      access_token: set.access_token,
      refresh_token: set.refresh_token ?? current.refresh_token,
      expires_at: set.expires_at,
      scope: set.scope ?? current.scope,
      instance,
    });
    return { access_token: set.access_token, instance };
  } finally {
    await release();
  }
}
