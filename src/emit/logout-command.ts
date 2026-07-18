/**
 * `sidestep logout` — sign out of the project-local token cache.
 *
 * Mirrors the sidestep dashboard BFF's logout: best-effort REVOKE the refresh
 * token at the authorization server (so a leaked cache file can't be replayed),
 * then delete the local cache. Revocation failure never blocks the local clear —
 * the important half is removing the credentials from disk.
 *
 * Node-only and lazily imported (like `login`/`push`) so `compile`/`export`
 * never pull in the OAuth stack.
 */
import type { ParsedArgs } from "./cli.js";
import { OpenIdProvider } from "../auth/oauth.js";
import { readTokens, clearTokens, resolveAuthFilePath } from "../auth/store.js";
import { resolveScope } from "../auth/config.js";

export async function runLogoutCommand(args: ParsedArgs): Promise<void> {
  const authFilePath = resolveAuthFilePath(args);
  const saved = readTokens(authFilePath);
  if (!saved) {
    process.stderr.write(`Not signed in (no token cache at ${authFilePath}). Nothing to do.\n`);
    return;
  }

  if (saved.refresh_token) {
    // Use the client that minted the token (we know its id, so no registration),
    // and revoke at the saved auth host. Best-effort: a network/AS failure must
    // not strand the user signed-in locally.
    const provider = new OpenIdProvider({
      authHost: saved.auth_host,
      scope: saved.scope ?? resolveScope(args),
      clientId: saved.client_id,
    });
    try {
      await provider.revoke(saved.refresh_token);
    } catch (err) {
      process.stderr.write(
        `Warning: could not revoke the refresh token at ${saved.auth_host} ` +
          `(${err instanceof Error ? err.message : String(err)}). Clearing local credentials anyway.\n`,
      );
    }
  }

  clearTokens(authFilePath);
  process.stderr.write(`Signed out of ${saved.instance}. Removed ${authFilePath}.\n`);
}
