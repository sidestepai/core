/**
 * `sidestep profile me` — print the scoped user and, most importantly, the
 * instance base URL. On an interactive terminal it prints an aligned, colorized
 * summary; when stdout is piped (an agent, `jq`, CI) it prints the projected
 * JSON verbatim, so machine consumers keep a stable, parseable contract.
 *
 * Reuses the existing `GET /api:meta/auth/me` endpoint. It **projects only**
 * `id`/`name`/`email` and the instance base URL (from the token binding via
 * `getAccessToken`) — it never emits the raw `extras` blob, which can carry OAuth
 * claims / membership internals and would land in shell history and CI logs.
 *
 * Node-only and lazily imported (like `login`/`logout`) so the browser-safe
 * authoring bundle never pulls in the OAuth stack.
 */
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { stdoutStyle, formatFields } from "./ui.js";

/** Bound the metadata fetch so a stalled endpoint can't hang the CLI. */
const PROFILE_TIMEOUT_MS = 30_000;

/** The projected, safe-to-print profile. Never carries the raw `extras` blob. */
export interface Profile {
  /** Instance base URL — the headline field, from the token's `aud` binding. */
  instance: string;
  user: { id: number | undefined; name: string | undefined; email: string | undefined };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Fetch and project the authenticated profile. The instance base URL comes from
 * the token binding (not the server); the user comes from `auth/me`. The raw
 * `extras` blob is deliberately dropped.
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
  return {
    instance,
    user: {
      id: typeof data.id === "number" ? data.id : undefined,
      name: asString(data.name),
      email: asString(data.email),
    },
  };
}

/** Render the profile as an aligned, colorized summary for an interactive terminal. */
function prettyProfile(p: Profile): string {
  const s = stdoutStyle();
  const who = [p.user.name, p.user.email && `<${p.user.email}>`].filter(Boolean).join(" ");
  const id = p.user.id !== undefined ? ` ${s.dim(`· id ${p.user.id}`)}` : "";
  return (
    "\n" +
    formatFields([
      ["Signed in", who !== "" ? `${who}${id}` : s.dim("(unknown user)")],
      ["Instance", s.bold(s.cyan(p.instance))],
    ])
  );
}

export async function runProfileCommand(args: ParsedArgs): Promise<void> {
  const profile = await fetchProfile(args);
  // A TTY gets the human summary; a pipe (agent/jq/CI) gets stable JSON.
  if (process.stdout.isTTY) {
    process.stdout.write(prettyProfile(profile));
  } else {
    process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
  }
}
