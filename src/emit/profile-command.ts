/**
 * `sidestep profile me` — print the scoped user and, most importantly, the
 * instance base URL, as JSON on stdout. An agent reads the instance URL to
 * configure a frontend's API base before a static-host upload.
 *
 * Reuses the existing `GET /api:meta/auth/me` endpoint. It **projects only**
 * `id`/`name`/`email`, the token-scoped workspace `{id, name}`, and the instance
 * base URL (from the token binding via `getAccessToken`) — it never emits the raw
 * `extras` blob, which can carry OAuth claims / membership internals and would
 * land in shell history and CI logs.
 *
 * This module also owns the shared **target-workspace resolver** the deploy
 * pre-flight (U7) and static-host path (U8) depend on: the numeric `workspace_id`
 * and name for the workspace the token is scoped to.
 *
 * Node-only and lazily imported (like `login`/`logout`) so the browser-safe
 * authoring bundle never pulls in the OAuth stack.
 */
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";

/** Bound the metadata fetch so a stalled endpoint can't hang the CLI. */
const PROFILE_TIMEOUT_MS = 30_000;

/** The projected, safe-to-print profile. Never carries the raw `extras` blob. */
export interface Profile {
  /** Instance base URL — the headline field, from the token's `aud` binding. */
  instance: string;
  user: { id: number | undefined; name: string | undefined; email: string | undefined };
  /** The token-scoped workspace, when the instance exposes its numeric id. */
  workspace: { id: number; name: string } | undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Fetch and project the authenticated profile. The instance base URL comes from
 * the token binding (not the server); the user + scoped workspace come from
 * `auth/me`. The raw `extras` blob is deliberately dropped.
 */
export async function fetchProfile(args: ParsedArgs): Promise<Profile> {
  const { access_token, instance } = await getAccessToken(args);
  const url = new URL("/api:meta/auth/me", instance);
  const res = await fetch(url.href, {
    headers: { Authorization: `Bearer ${access_token}` },
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`profile me failed (${res.status} ${res.statusText}):\n${text}`);
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`profile me: could not parse the ${url.pathname} response as JSON:\n${text}`);
  }
  // The token-scoped workspace `{id, name}` — a backend affordance (auth/me
  // returns it, or a dedicated resolve endpoint). `extras.oauth.workspace`
  // carries only a guid, so the numeric id is not otherwise derivable client-side.
  const ws = data.workspace as { id?: unknown; name?: unknown } | undefined;
  const workspace =
    ws && typeof ws.id === "number" ? { id: ws.id, name: asString(ws.name) ?? "" } : undefined;
  return {
    instance,
    user: {
      id: typeof data.id === "number" ? data.id : undefined,
      name: asString(data.name),
      email: asString(data.email),
    },
    workspace,
  };
}

export async function runProfileCommand(args: ParsedArgs): Promise<void> {
  const profile = await fetchProfile(args);
  process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
}

/** The token-scoped deploy target: the numeric workspace id + name the endpoints key on. */
export interface TargetWorkspace {
  instance: string;
  workspaceId: number;
  workspaceName: string;
}

/**
 * Shared resolver for the deploy pre-flight display (U7) and the static-host
 * build path (U8), which needs a numeric `workspace_id` in its URL. Fails
 * actionably when the instance doesn't expose the token-scoped workspace id.
 */
export async function resolveTargetWorkspace(args: ParsedArgs): Promise<TargetWorkspace> {
  const profile = await fetchProfile(args);
  if (!profile.workspace) {
    throw new Error(
      `Could not resolve the token's target workspace from ${profile.instance}/api:meta/auth/me ` +
        `(no workspace {id, name} in the response). The instance must expose the token-scoped ` +
        `workspace id for a real deploy — upgrade the backend or re-run \`sidestep login\`.`,
    );
  }
  return {
    instance: profile.instance,
    workspaceId: profile.workspace.id,
    workspaceName: profile.workspace.name,
  };
}
