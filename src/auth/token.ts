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
  readCredential,
  writeCredential,
  clearCredential,
  resolveAuthFilePath,
  globalAuthFilePath,
  localAuthFilePath,
  type CredentialRecord,
  type OAuthCredential,
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

/**
 * The minimum any meta-API call needs: a bearer plus the origin it is valid for.
 * Transports that address a route directly (deploy POSTs, the workspace-id
 * lookup) take THIS, not {@link ResolvedAuth} — they have no business reading a
 * workspace id, and one of them is what derives it.
 */
export interface BearerTarget {
  access_token: string;
  /** Instance origin the token is bound to (also the push URL host). */
  instance: string;
}

/**
 * A usable bearer token plus the exact target it authorizes against.
 *
 * `workspaceId` is part of the credential, not a per-command choice: there is no
 * `--workspace` flag and no other way to reach a workspace id, so a command
 * physically cannot act on a workspace the credential is not bound to.
 */
export interface ResolvedAuth extends BearerTarget {
  /** Numeric workspace every command acts on. */
  workspaceId: number;
  /**
   * Which credential produced this. Reported by `workspace details` so a user
   * can see what they are acting under before a command acts. `"oauth"` covers
   * the CI refresh-grant path too — it is the same credential, minted per-run.
   */
  credentialType: "oauth" | "token";
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
 * Resolve a bearer token and the target it authorizes against. The instance and
 * workspace always come from the credential — chosen at consent during `login`
 * or hand-authored in a `"token"` record. Never a flag.
 *
 * Three paths:
 *   • CI (`XANO_REFRESH_TOKEN`) — exchange it; the instance is read back from
 *     the fresh token's `aud` and the workspace resolved from the meta API,
 *     since there is no stored record to read either from. No disk I/O.
 *   • `"oauth"` credential — refresh + persist the rotated refresh token when
 *     the cached access token is stale; the workspace was pinned at login.
 *   • `"token"` credential — everything is already on disk. No refresh, no
 *     network call, no write.
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
    // No stored record on this path, so the workspace must be resolved live.
    const { resolveScopedWorkspaceId } = await import("../deploy/workspace.js");
    const workspaceId = await resolveScopedWorkspaceId({ access_token: set.access_token, instance });
    return { access_token: set.access_token, instance, workspaceId, credentialType: "oauth" };
  }

  const authFilePath = resolveAuthFilePath(args);
  const saved = readCredential(authFilePath);
  if (!saved) {
    throw new Error(
      `Not signed in (no credential at ${authFilePath}). ` +
        `Run \`sidestep login\` first, or set XANO_REFRESH_TOKEN for CI.`,
    );
  }

  warnIfLocalShadowsGlobal(args, authFilePath, saved);

  // A hand-authored meta-API token is already complete: it never expires from
  // our point of view, never refreshes, and is never written back.
  if (saved.type === "token") {
    assertHttpsOrigin(saved.instance_base_url, "instance_base_url");
    return {
      access_token: saved.meta_api_token,
      instance: saved.instance_base_url,
      workspaceId: saved.workspace_id,
      credentialType: "token",
    };
  }

  const instance = saved.instance;
  assertHttpsOrigin(instance, "instance");

  if (Date.now() < saved.expires_at - EXPIRY_SKEW_MS) {
    return {
      access_token: saved.access_token,
      instance,
      workspaceId: saved.workspace_id,
      credentialType: "oauth",
    };
  }

  return refreshUnderLock(authFilePath, saved);
}

/** The `(instance, workspace)` a credential addresses, regardless of arm. */
function targetOf(credential: CredentialRecord): { instance: string; workspaceId: number } {
  return credential.type === "token"
    ? { instance: credential.instance_base_url, workspaceId: credential.workspace_id }
    : { instance: credential.instance, workspaceId: credential.workspace_id };
}

/**
 * Loud guard against a project-local credential silently shadowing the global
 * default. Read mode prefers a local `./.xano/auth.json` over the global one,
 * which — if the two address DIFFERENT targets — would point a full-replace
 * deploy at the wrong place with no visible sign.
 *
 * Compares the whole `(instance, workspace)` target, across arms: a local
 * `"token"` credential shadowing a global `"oauth"` one is the same hazard, and
 * is now more likely since both types share the file. A divergent workspace on
 * the same instance is just as damaging as a divergent instance.
 *
 * Only fires for the *default* resolution (no `--config`/`$XANO_CONFIG`, no
 * `--local`) that landed on the local file while a divergent global one also
 * exists. An explicit path or `--local` is a deliberate choice and stays quiet.
 */
function warnIfLocalShadowsGlobal(args: ParsedArgs, resolved: string, saved: CredentialRecord): void {
  const isDefaultResolution = args.authFile === undefined && process.env.XANO_CONFIG === undefined && !args.local;
  if (!isDefaultResolution || resolved !== localAuthFilePath()) return;
  const globalPath = globalAuthFilePath();
  if (globalPath === resolved) return;

  // A broken/stale global credential must not blow up a run that isn't using it.
  let globalSaved: CredentialRecord | null = null;
  try {
    globalSaved = readCredential(globalPath);
  } catch {
    return;
  }
  if (!globalSaved) return;

  const here = targetOf(saved);
  const there = targetOf(globalSaved);
  if (here.instance === there.instance && here.workspaceId === there.workspaceId) return;

  warn(
    `Using project-local ${resolved} (${hostLabel(here.instance)}, workspace ${here.workspaceId}), ` +
      `but a global credential for ${hostLabel(there.instance)}, workspace ${there.workspaceId} ` +
      `also exists — the local one wins. Remove ./.xano/auth.json (or pass --config) to use the ` +
      `global credential instead.`,
  );
}

/**
 * Refresh + persist the token cache while holding a cross-process advisory lock.
 * After acquiring the lock we RE-READ the cache: if a concurrent `push`
 * refreshed while we waited, we use its result instead of spending our
 * now-stale refresh token a second time.
 */
async function refreshUnderLock(authFilePath: string, saved: OAuthCredential): Promise<ResolvedAuth> {
  const release = await lockfile.lock(authFilePath, REFRESH_LOCK_OPTS);
  try {
    // Re-read, but only trust it if it's still the same arm: a concurrent
    // process could have replaced the file with a hand-authored credential.
    const reread = readCredential(authFilePath);
    const current = reread?.type === "oauth" ? reread : saved;
    const instance = current.instance;
    const workspaceId = current.workspace_id;
    if (Date.now() < current.expires_at - EXPIRY_SKEW_MS) {
      return { access_token: current.access_token, instance, workspaceId, credentialType: "oauth" };
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
        clearCredential(authFilePath);
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
    writeCredential(authFilePath, {
      ...current,
      access_token: stamped.access_token,
      refresh_token: stamped.refresh_token ?? current.refresh_token,
      expires_at: stamped.expires_at,
      scope: stamped.scope ?? current.scope,
    });
    return { access_token: stamped.access_token, instance, workspaceId, credentialType: "oauth" };
  } finally {
    await release();
  }
}
