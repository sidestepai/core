/**
 * `sidestep login [--instance <origin>]` — run the OAuth 2.1 authorization-code +
 * PKCE flow against the cloud-master control-plane and cache the resulting
 * tokens locally for reuse by `push`.
 *
 * Flow: discover endpoints → start a fixed-port 127.0.0.1 loopback server →
 * dynamically register (or reuse) a client whose redirect_uri is exactly that
 * loopback URL → open the browser to the authorize URL → capture the code →
 * exchange it → read the bound instance from the token's `aud` claim → write the
 * project-local cache (0600) and ensure it is gitignored.
 *
 * `--instance` is OPTIONAL: when given it pre-selects the instance (RFC 8707
 * `resource`); when omitted the user picks it at the hosted consent screen. The
 * saved instance is always the token's true audience, not the flag value.
 *
 * All progress/prompts go to STDERR (stdout stays clean, matching `push`).
 * Node-only and lazily imported so `compile`/`export` never pull in `node:http`.
 */
import type { ParsedArgs } from "./cli.js";
import {
  discover,
  generatePkce,
  randomState,
  buildAuthorizeUrl,
  exchangeCode,
  decodeAudience,
  CALLBACK_PATH,
  DEFAULT_PORT,
} from "../auth/oauth.js";
import { getOrRegisterClient } from "../auth/client-store.js";
import { startCallbackServer, openBrowser } from "../auth/loopback.js";
import { writeTokens, ensureGitignored, resolveAuthFilePath, type TokenRecord } from "../auth/store.js";
import { resolveInstance, resolveAuthHost, resolveScope, assertHttpsOrigin } from "../auth/config.js";

export async function runLoginCommand(args: ParsedArgs): Promise<void> {
  const instance = resolveInstance(args); // optional pre-selection
  const authHost = resolveAuthHost(args);
  const scope = resolveScope(args);
  const port = args.port ?? DEFAULT_PORT;
  assertHttpsOrigin(authHost, "--auth-host");
  if (instance) assertHttpsOrigin(instance, "--instance");

  process.stderr.write(
    `Signing in${instance ? ` to ${instance}` : ""} via ${authHost}…\n`,
  );

  const { authorization_endpoint, token_endpoint, registration_endpoint } = await discover(authHost);
  if (!registration_endpoint) {
    throw new Error(
      `The OAuth server at ${authHost} does not advertise a registration endpoint, ` +
        `so sidestep can't register its loopback client. Check --auth-host.`,
    );
  }
  const { verifier, challenge } = generatePkce();
  const state = randomState();

  let listener;
  try {
    listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: state, port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new Error(`Loopback port ${port} is in use. Pass a free one with --port <n> and retry.`);
    }
    throw err;
  }

  const clientId = await getOrRegisterClient({
    authHost,
    redirectUri: listener.redirectUri,
    registrationEndpoint: registration_endpoint,
    scope,
  });

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: authorization_endpoint,
    clientId,
    redirectUri: listener.redirectUri,
    instance,
    scope,
    state,
    codeChallenge: challenge,
  });

  process.stderr.write(`Opening your browser to authorize. If it doesn't open, visit:\n  ${authorizeUrl}\n`);
  openBrowser(authorizeUrl);

  let code: string;
  try {
    code = await listener.waitForCode;
  } catch (err) {
    listener.close();
    throw err;
  }

  const tokens = await exchangeCode({
    tokenEndpoint: token_endpoint,
    clientId,
    code,
    codeVerifier: verifier,
    redirectUri: listener.redirectUri,
    instance,
  });

  // The token's `aud` claim is the authoritative instance binding (the user may
  // have chosen it at consent). Fall back to the pre-selected --instance.
  const boundInstance = decodeAudience(tokens.access_token) ?? instance;
  if (!boundInstance) {
    throw new Error(
      `Could not determine the instance from the issued token. ` +
        `Re-run with --instance <origin> to bind explicitly.`,
    );
  }
  if (instance && boundInstance !== instance) {
    process.stderr.write(
      `Note: signed in to ${boundInstance} (chosen at consent), not the ${instance} you passed.\n`,
    );
  }

  const record: TokenRecord = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    scope: tokens.scope ?? scope,
    instance: boundInstance,
    auth_host: authHost,
    client_id: clientId,
  };

  const authFilePath = resolveAuthFilePath(args);
  writeTokens(authFilePath, record);
  process.stderr.write(`Signed in. Tokens saved to ${authFilePath}.\n`);

  // Tokens are already durably saved; a .gitignore failure must not fail the
  // login (and thus exit non-zero). Warn and continue.
  try {
    if (ensureGitignored(authFilePath)) {
      process.stderr.write(`Added the token cache to .gitignore.\n`);
    }
  } catch (err) {
    process.stderr.write(
      `Warning: could not update .gitignore (${err instanceof Error ? err.message : String(err)}). ` +
        `Add ${authFilePath} to your ignore rules manually.\n`,
    );
  }
  if (!tokens.refresh_token) {
    process.stderr.write(
      `Warning: no refresh token was issued (offline_access not granted); ` +
        `push will require re-login once the access token expires.\n`,
    );
  }
}
