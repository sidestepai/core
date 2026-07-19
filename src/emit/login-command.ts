/**
 * `sidestep login` — run the OAuth 2.1 authorization-code + PKCE flow against the
 * cloud-master control-plane and cache the resulting tokens locally for reuse by
 * `push`.
 *
 * Flow: start a fixed-port 127.0.0.1 loopback server → build an OpenIdProvider
 * (discovers endpoints and dynamically registers, or reuses, a client whose
 * redirect_uri is exactly that loopback URL) → open the browser to the authorize
 * URL → capture the callback → exchange the code → read the bound instance from
 * the token's `aud` claim → write the project-local cache (0600) and ensure it
 * is gitignored.
 *
 * The user always picks the target instance at the hosted consent screen (like
 * the dashboard); the saved instance is the token's true `aud`, never a flag.
 *
 * Robustness: a stale DCR client (the AS forgot our registration) surfaces as
 * `invalid_client` at authorize OR exchange; we drop the cached client and retry
 * the whole flow ONCE, mirroring the dashboard BFF's callback recovery.
 *
 * All progress/prompts go to STDERR (stdout stays clean, matching `push`).
 * Node-only and lazily imported so `compile`/`export` never pull in `node:http`.
 */
import * as client from "openid-client";
import type { ParsedArgs } from "./cli.js";
import { OpenIdProvider, oauthErrorCode, decodeAudience, CALLBACK_PATH, DEFAULT_PORT } from "../auth/oauth.js";
import { startCallbackServer, openBrowser } from "../auth/loopback.js";
import { writeTokens, ensureGitignored, resolveAuthFilePath, type TokenRecord } from "../auth/store.js";
import { resolveAuthHost, resolveScope, assertHttpsOrigin } from "../auth/config.js";
import { step, success, warn, detail, blank, hostLabel } from "./ui.js";

export async function runLoginCommand(args: ParsedArgs): Promise<void> {
  const authHost = resolveAuthHost(args);
  const scope = resolveScope(args);
  const port = args.port ?? DEFAULT_PORT;
  assertHttpsOrigin(authHost, "--origin");

  step(`Signing in to ${hostLabel(authHost)}`);

  let record: TokenRecord;
  try {
    record = await attemptLogin({ authHost, scope, port });
  } catch (err) {
    // A rejected registration can't be salvaged mid-flight: reset() (inside
    // attemptLogin) already dropped it, so retry the whole flow once with a
    // fresh registration.
    if (oauthErrorCode(err) !== "invalid_client") throw err;
    warn("The registered client was rejected — re-registering and retrying once.");
    record = await attemptLogin({ authHost, scope, port });
  }

  const authFilePath = resolveAuthFilePath(args, "write");
  writeTokens(authFilePath, record);

  blank();
  success(`Signed in to ${hostLabel(record.instance)}`);
  detail(`Tokens saved to ${authFilePath}`);
  if (args.global) {
    detail("Using the shared ~/.sidestep cache — available from any project directory.");
  }

  // Tokens are already durably saved; a .gitignore failure must not fail the
  // login (and thus exit non-zero). Warn and continue.
  try {
    if (ensureGitignored(authFilePath)) {
      detail("Added the token cache to .gitignore");
    }
  } catch (err) {
    warn(
      `Could not update .gitignore (${err instanceof Error ? err.message : String(err)}). ` +
        `Add ${authFilePath} to your ignore rules manually.`,
    );
  }
  if (!record.refresh_token) {
    warn(
      "No refresh token was issued (offline_access not granted); " +
        "push will require re-login once the access token expires.",
    );
  }
}

/**
 * One end-to-end login attempt. On `invalid_client` it drops the stale
 * registration (`provider.reset()`) and rethrows so the caller can retry with a
 * fresh one. Every other outcome (success or a real failure) is returned/thrown
 * as-is.
 */
async function attemptLogin(p: {
  authHost: string;
  scope: string;
  port: number;
}): Promise<TokenRecord> {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();

  let listener;
  try {
    listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: state, port: p.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new Error(`Loopback port ${p.port} is in use. Pass a free one with --port <n> and retry.`);
    }
    throw err;
  }

  const provider = new OpenIdProvider({ authHost: p.authHost, redirectUri: listener.redirectUri, scope: p.scope });

  let authorizeUrl: string;
  try {
    authorizeUrl = await provider.buildAuthUrl({ verifier, state });
  } catch (err) {
    listener.close();
    throw err;
  }

  detail("Opening your browser to authorize — waiting for you to finish…");
  detail("If it doesn't open, paste this URL into your browser:");
  detail(authorizeUrl);
  openBrowser(authorizeUrl);

  let callbackUrl: string;
  try {
    ({ callbackUrl } = await listener.waitForCallback);
  } catch (err) {
    listener.close();
    // An authorize-time `invalid_client` (the loopback tags it on `.error`)
    // is recoverable: drop the stale registration and let the caller retry.
    if (oauthErrorCode(err) === "invalid_client") await provider.reset();
    throw err;
  }

  let tokens;
  try {
    tokens = await provider.exchange(callbackUrl, { verifier, state });
  } catch (err) {
    if (oauthErrorCode(err) === "invalid_client") await provider.reset();
    throw err;
  }

  // The instance is whatever the user chose at consent — read it back from the
  // token's `aud` claim (the authoritative binding).
  const boundInstance = decodeAudience(tokens.access_token);
  if (!boundInstance) {
    throw new Error(
      `Could not determine the instance from the issued token (no readable \`aud\` claim). ` +
        `This is unexpected — please report it.`,
    );
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 0) * 1000,
    scope: tokens.scope ?? p.scope,
    instance: boundInstance,
    auth_host: p.authHost,
    // Record exactly which client minted the token — required to refresh/revoke
    // it later. Resolved already (buildAuthUrl awaited the config).
    client_id: provider.clientId(),
  };
}
