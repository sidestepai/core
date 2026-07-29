/**
 * `sidestep logout` — sign out of the shared `~/.sidestep` cache (or the
 * project-local token cache with `--local`).
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
import { readCredential, clearCredential, resolveAuthFilePath, globalAuthFilePath } from "../auth/store.js";
import { resolveScope } from "../auth/config.js";
import { success, warn, info, detail, hostLabel } from "./ui.js";

export async function runLogoutCommand(args: ParsedArgs): Promise<void> {
  // "write" mode: like `login`, target a definite cache. Defaults to the shared
  // global cache (the common sign-in); `--local` clears the project cache
  // instead. Never falls back between the two — the target is exactly the one
  // the flag (or its absence) names.
  const authFilePath = resolveAuthFilePath(args, "write");
  const targetsGlobal = authFilePath === globalAuthFilePath();

  // A stale/invalid credential must still be removable — that is the whole point
  // of logout. Fall back to a bare delete rather than stranding the user with a
  // read error and a file they cannot clear through the CLI.
  let saved;
  try {
    saved = readCredential(authFilePath);
  } catch (err) {
    warn(`Could not read ${authFilePath} (${err instanceof Error ? err.message : String(err)}).`);
    if (clearCredential(authFilePath)) {
      success("Removed the unreadable credential file.");
      detail(`Removed ${authFilePath}`);
    }
    return;
  }

  if (!saved) {
    // An explicitly requested logout that finds nothing is worth an `i` line
    // (your command had no effect), not a dim incidental detail.
    info(`Not signed in (no credential at ${authFilePath}). Nothing to do.`);
    return;
  }

  // The global file is reused across every project, so clearing it here affects
  // every one of them — surface that before the irreversible delete. True for
  // both arms: a hand-authored global credential is just as widely shared.
  if (targetsGlobal) {
    warn("Clearing the shared ~/.sidestep credential — this affects every project that reuses it.");
  }

  // A hand-authored meta-API token has no session to revoke and no authorization
  // server to revoke it at. Removing the file is the whole operation, and saying
  // "signed out" would overstate it — the token itself remains valid until the
  // user revokes it wherever they minted it.
  if (saved.type === "token") {
    clearCredential(authFilePath);
    success(`Removed the meta API token credential for ${hostLabel(saved.instance_base_url)}`);
    detail(`Removed ${authFilePath}`);
    detail("The token itself is still valid — revoke it at its source if you need it dead.");
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

  clearCredential(authFilePath);
  success(`Signed out of ${hostLabel(saved.instance)}`);
  detail(`Removed ${authFilePath}`);
}
