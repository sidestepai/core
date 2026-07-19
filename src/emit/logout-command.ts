/**
 * `sidestep logout` — sign out of the project-local token cache (or the shared
 * `~/.sidestep` cache with `--global`).
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
import { success, warn, detail, hostLabel } from "./ui.js";

export async function runLogoutCommand(args: ParsedArgs): Promise<void> {
  // "write" mode: like `login`, target a definite cache. Clearing credentials
  // must never silently fall back to the shared global cache — a plain `logout`
  // in a project with no local cache is a no-op, not a revoke of `--global`.
  const authFilePath = resolveAuthFilePath(args, "write");
  const saved = readTokens(authFilePath);
  if (!saved) {
    detail(`Not signed in (no token cache at ${authFilePath}). Nothing to do.`);
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
      warn(
        `Could not revoke the refresh token at ${hostLabel(saved.auth_host)} ` +
          `(${err instanceof Error ? err.message : String(err)}). Clearing local credentials anyway.`,
      );
    }
  }

  clearTokens(authFilePath);
  success(`Signed out of ${hostLabel(saved.instance)}`);
  detail(`Removed ${authFilePath}`);
}
