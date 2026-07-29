/**
 * Node-only: resolve the numeric workspace id the caller's OAuth token is scoped
 * to. The static-frontend deploy targets the caller's real (parent) workspace —
 * the sandbox tenant does not serve static hosting — and the static-host meta
 * routes key on a NUMERIC workspace id, which the token itself does not carry
 * directly (it carries the workspace *guid* it consented to).
 *
 * `GET /api:meta/auth/me` returns both halves of the mapping:
 *   - `extras.oauth.workspace`               — the guid the token is scoped to
 *   - `extras.instance.membership.workspace` — `[{ guid, id }]` for the account
 * so we match the scoped guid against the membership list to get its id. When the
 * token carries no scoped guid but the account has exactly one workspace, we use
 * that; anything ambiguous is a hard error rather than a wrong-workspace deploy.
 *
 * Lazily imported by the command layer so the browser-safe authoring bundle never
 * pulls this Node-only transport in.
 */
import type { BearerTarget } from "../auth/token.js";

const RESOLVE_TIMEOUT_MS = 30_000;

interface MembershipWorkspace {
  guid?: unknown;
  id?: unknown;
}

/**
 * Resolve the numeric id of the workspace the token is scoped to (see module
 * header). Called in exactly two places: `login` (to pin it) and the
 * `XANO_REFRESH_TOKEN` CI path (which has no stored record to read it from).
 *
 * Takes a `BearerTarget`, not a `ResolvedAuth`: this function *produces* the
 * workspace id the fuller type carries.
 */
export async function resolveScopedWorkspaceId(auth: BearerTarget): Promise<number> {
  const url = new URL("/api:meta/auth/me", auth.instance);
  const res = await fetch(url.href, {
    headers: { Authorization: `Bearer ${auth.access_token}` },
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`resolve workspace failed (${res.status} ${res.statusText}):\n${text}`);
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`resolve workspace: could not parse the ${url.pathname} response as JSON:\n${text}`);
  }

  const extras = (data.extras ?? {}) as Record<string, unknown>;
  const oauth = (extras.oauth ?? {}) as Record<string, unknown>;
  const instance = (extras.instance ?? {}) as Record<string, unknown>;
  const membership = (instance.membership ?? {}) as Record<string, unknown>;
  const list = Array.isArray(membership.workspace) ? (membership.workspace as MembershipWorkspace[]) : [];

  const scopedGuid = typeof oauth.workspace === "string" ? oauth.workspace : undefined;
  if (scopedGuid !== undefined && scopedGuid !== "") {
    const match = list.find((w) => w.guid === scopedGuid);
    if (match !== undefined && typeof match.id === "number") return match.id;
  }
  // No scoped guid (or it wasn't in the membership list): only safe to guess when
  // the account has exactly one workspace.
  const ids = list.filter((w): w is { id: number } => typeof w.id === "number");
  if (ids.length === 1) return ids[0]!.id;

  throw new Error(
    `Could not resolve which workspace this token is scoped to ` +
      `(scoped workspace ${scopedGuid ?? "(none)"} not found among ${ids.length} membership workspaces). ` +
      `Run \`sidestep login\` again and pick a single workspace at the consent screen. ` +
      `There is no workspace override — a credential addresses exactly one workspace.`,
  );
}
