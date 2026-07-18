/**
 * Global cache of Dynamically-Registered OAuth clients (RFC 7591). A client is
 * registered once per (auth host + redirect URI) and reused across every project
 * — unlike the per-project token cache, the client registration is a machine
 * fact, so it lives in `~/.xano/sidestep-clients.json` (0600). Reusing it avoids
 * re-hitting the rate-limited registration endpoint on every login.
 *
 * Node-only; never reachable from the browser-safe `index.ts` surface.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { registerClient } from "./oauth.js";

interface ClientRecord {
  client_id: string;
}

/** Location of the global client cache (overridable for tests). */
export function clientStorePath(): string {
  return process.env.XANO_CLIENT_FILE ?? join(homedir(), ".xano", "sidestep-clients.json");
}

/** Stable key for one registration: the auth host plus the exact redirect URI. */
function key(authHost: string, redirectUri: string): string {
  return `${authHost}|${redirectUri}`;
}

function readAll(path: string): Record<string, ClientRecord> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, ClientRecord>) : {};
  } catch {
    // A corrupt cache is non-fatal — re-register and overwrite.
    return {};
  }
}

/**
 * Return the client_id registered for (authHost, redirectUri), registering a
 * new one (and caching it) when none exists. The registration's redirect_uri is
 * exactly `redirectUri`, so the authorize exact-match check always passes.
 */
export async function getOrRegisterClient(params: {
  authHost: string;
  redirectUri: string;
  registrationEndpoint: string;
  scope: string;
}): Promise<string> {
  const path = clientStorePath();
  const all = readAll(path);
  const k = key(params.authHost, params.redirectUri);
  const cached = all[k];
  if (cached?.client_id) return cached.client_id;

  const { client_id } = await registerClient({
    registrationEndpoint: params.registrationEndpoint,
    redirectUri: params.redirectUri,
    scope: params.scope,
  });
  all[k] = { client_id };
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  return client_id;
}
