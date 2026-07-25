/**
 * `sidestep ephemeral <list|get|delete|export>` — manage the ephemeral
 * environments `sidestep deploy` creates. Mirrors the `sandbox` read surface
 * (`get` ≈ `sandbox details`, `export` ≈ `sandbox export`) and reuses the same
 * `resolveOutputTarget`/`formatFields`/`formatExpiration` primitives so the two
 * families render consistently.
 *
 * Expired/gone handling is the crux: `get`, `export`, and `delete` resolve the
 * tenant through the parent meta-API FIRST — that both yields the base URL (for
 * a json export) and is the existence gate. A 404 (swept by the server) or a
 * past `ephemeral_expires_at` is surfaced as one actionable message ("expired or
 * no longer exists — run `sidestep deploy`"), the dead env's base URL is never
 * touched, and a matching local `.xano/ephemeral.json` record is cleared so the
 * next deploy starts clean.
 *
 * Node-only (fetch/fs + OAuth) and lazily imported by the CLI so the browser-safe
 * authoring bundle never pulls it in.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import {
  getEphemeral,
  listEphemeral,
  listAllEphemeral,
  deleteEphemeral,
  isExpired,
  type EphemeralSummary,
} from "../deploy/ephemeral.js";
import { readEphemeralState, getEnvironment, clearEnvironment } from "../deploy/ephemeral-state.js";
import { resolveScopedWorkspaceId } from "../deploy/workspace.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import { resolveOutputTarget } from "./sandbox-export-command.js";
import { step, success, warn, detail, info, formatFields, formatExpiration, stdoutStyle, style } from "./ui.js";

const TIMEOUT_MS = 120_000;

/**
 * Resolve the parent workspace id these tenant routes are scoped to: an explicit
 * `--workspace` wins; otherwise resolve it from the caller's token scope. Never
 * hard-codes 1 — instances number workspaces from their own sequence, so a fixed
 * 1 404s ("Invalid workspace") wherever the primary workspace isn't id 1 (mirrors
 * `deploy`'s `resolveParentWorkspaceId`).
 */
async function parentWorkspace(args: ParsedArgs, auth: ResolvedAuth): Promise<number> {
  return args.workspace ?? (await resolveScopedWorkspaceId(auth));
}

/** The clear, actionable message for an ephemeral that has expired or been swept. */
function goneError(name: string, clearedState: boolean): Error {
  const tail = clearedState ? " (cleared its local record)" : "";
  return new Error(
    `Ephemeral "${name}" has expired or no longer exists. Run \`sidestep deploy\` to create a fresh one.${tail}`,
  );
}

/**
 * Resolve a tenant for a read/export/delete verb, enforcing the gone/expired
 * gate. Returns the live summary, or throws the actionable message after clearing
 * any matching local record. Never touches the env base URL for a dead tenant.
 */
async function resolveLive(
  auth: ResolvedAuth,
  parentWorkspaceId: number,
  name: string,
): Promise<EphemeralSummary> {
  const summary = await getEphemeral(auth, { parentWorkspaceId, name });
  if (summary === null || isExpired(summary.expiresAt)) {
    const cleared = clearStaleRecord(parentWorkspaceId, name);
    throw goneError(name, cleared);
  }
  return summary;
}

/** Clear the local record for this parent workspace when it points at `name`. Returns whether it did. */
function clearStaleRecord(parentWorkspaceId: number, name: string): boolean {
  const tracked = getEnvironment(readEphemeralState(process.cwd()), parentWorkspaceId);
  if (tracked?.name === name) return clearEnvironment(process.cwd(), parentWorkspaceId);
  return false;
}

export async function runEphemeralCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "list":
      return runList(args);
    case "get":
      return runGet(args);
    case "delete":
      return runDelete(args);
    case "export":
      return runExport(args);
    default:
      throw new Error(
        `Unknown ephemeral subcommand "${args.subcommand ?? ""}". ` +
          `Expected \`list\`, \`get <name>\`, \`delete <name>\`, or \`export <name>\`.`,
      );
  }
}

// ── list ────────────────────────────────────────────────────────────────────

async function runList(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  const rows = args.allWorkspaces
    ? await listAllEphemeral(auth)
    : await listEphemeral(auth, { parentWorkspaceId: await parentWorkspace(args, auth) });

  if (!process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  const s = stdoutStyle();
  if (rows.length === 0) {
    process.stdout.write("No ephemeral tenants found\n");
    return;
  }
  const lines = rows.map((r) => {
    const exp = formatExpiration(r.expiresAt);
    const expTxt = exp === "expired" ? s.red("expired") : s.dim(`expires ${exp}`);
    const state = r.state ? s.dim(`[${r.state}]`) : "";
    const ws = args.allWorkspaces && r.workspaceId ? s.dim(` (workspace ${r.workspaceId})`) : "";
    return `  ${s.bold(r.display ?? r.name)} ${s.dim(`(${r.name})`)} ${state} ${expTxt}${ws}`;
  });
  process.stdout.write(lines.join("\n") + "\n");
}

// ── get ─────────────────────────────────────────────────────────────────────

async function runGet(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "get");
  const auth = await getAccessToken(args);
  const parentWorkspaceId = await parentWorkspace(args, auth);
  const summary = await resolveLive(auth, parentWorkspaceId, name);

  if (!process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }
  const s = stdoutStyle();
  const rows: Array<[string, string]> = [];
  if (summary.url) rows.push(["Base URL", s.bold(s.cyan(summary.url))]);
  rows.push(["Ephemeral", `${summary.display ?? summary.name} ${s.dim(`(${summary.name})`)}`]);
  if (summary.state) rows.push(["State", summary.state]);
  rows.push(["Expires", s.dim(formatExpiration(summary.expiresAt))]);
  process.stdout.write("\n" + formatFields(rows));
}

// ── delete ──────────────────────────────────────────────────────────────────

async function runDelete(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "delete");
  const auth = await getAccessToken(args);
  const parentWorkspaceId = await parentWorkspace(args, auth);

  if (!args.yes && !args.force) {
    const ok = await confirm(`Delete ephemeral "${name}"? This destroys it permanently.`);
    if (!ok) {
      info("Deletion cancelled.");
      return;
    }
  }

  const { alreadyGone } = await deleteEphemeral(auth, { parentWorkspaceId, name });
  const cleared = clearStaleRecord(parentWorkspaceId, name);
  if (alreadyGone) {
    warn(`Ephemeral "${name}" was already gone${cleared ? " (cleared its local record)" : ""}.`);
  } else {
    success(`Deleted ephemeral ${name}${cleared ? " (cleared its local record)" : ""}`);
  }
}

// ── export ──────────────────────────────────────────────────────────────────

async function runExport(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "export");
  const format = args.format ?? "json";
  const auth = await getAccessToken(args);
  const parentWorkspaceId = await parentWorkspace(args, auth);
  // Gone/expired gate first — this also yields the base URL for the json export.
  const summary = await resolveLive(auth, parentWorkspaceId, name);

  const { content, ext } =
    format === "multidoc"
      ? { content: await fetchEphemeralMultidoc(auth, parentWorkspaceId, name), ext: "xs" as const }
      : { content: await fetchEphemeralJson(auth, summary, name), ext: "json" as const };

  const target = resolveOutputTarget({ path: args.path, name, ext });
  if (target.kind === "stdout") {
    process.stdout.write(content + "\n");
    return;
  }
  writeFileSync(target.path, content + "\n", "utf8");
  step(`Exported ${format} → ${target.path}`);
  success(`Wrote ${target.path}`);
}

/** Export the ephemeral's XanoScript multidoc via the tenant multidoc route. */
async function fetchEphemeralMultidoc(auth: ResolvedAuth, parentWorkspaceId: number, name: string): Promise<string> {
  const url = new URL(`/api:meta/workspace/${parentWorkspaceId}/tenant/${name}/multidoc`, auth.instance);
  const res = await fetch(url.href, {
    headers: { accept: "text/x-xanoscript", Authorization: `Bearer ${auth.access_token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ephemeral export (multidoc) failed (${res.status} ${res.statusText}):\n${text}`);
  return text;
}

/**
 * Export the ephemeral's workspace as the JSON bundle: the env workspace id is
 * always 1, so `POST {base_url}/api:meta/workspace/1/export` → decode archive.
 * Guards the base-URL call so an env that dies after the existence gate surfaces
 * the same expired/gone message rather than a raw transport error.
 */
async function fetchEphemeralJson(auth: ResolvedAuth, summary: EphemeralSummary, name: string): Promise<string> {
  if (summary.url === undefined) throw goneError(name, false);
  try {
    const res = await fetch(`${summary.url.replace(/\/$/, "")}/api:meta/workspace/1/export`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "", password: "" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ephemeral export (workspace export) failed (${res.status} ${res.statusText}):\n${text}`);
    }
    const bundle = decodeWorkspaceArchive(new Uint8Array(await res.arrayBuffer()));
    return JSON.stringify(bundle, null, 2);
  } catch (err) {
    // The env can vanish between the existence gate and this call — map a dead
    // host to the same actionable message rather than a raw DNS/connection error.
    if (err instanceof Error && /failed \(\d/.test(err.message)) throw err;
    detail(err instanceof Error ? err.message : String(err));
    throw goneError(name, false);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function requireName(args: ParsedArgs, verb: string): string {
  const name = args.positionals[0];
  if (name === undefined || name === "") {
    throw new Error(`\`sidestep ephemeral ${verb}\` needs a tenant name. Run \`sidestep ephemeral list\` to see them.`);
  }
  return name;
}

/** Yes/no prompt on the tty. Progress-style so it reads with the rest of the stderr UI. */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((res) => rl.question(`${style.yellow("?")} ${message} (y/N) `, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
