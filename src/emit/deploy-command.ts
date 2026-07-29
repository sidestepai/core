/**
 * `sidestep deploy [--dest sandbox|ephemeral]` — compile-or-load a bundle and
 * import it into an environment. Default `--dest ephemeral`.
 *
 * The two destinations share one archive-import core: each env is its own Xano
 * environment at its own base URL, the caller's SAME OAuth token authenticates
 * there, and the import goes to `{base_url}/api:meta/workspace/1/import` — a full
 * clear-then-replace (reset is inherent; there is no opt-out).
 *
 *   • `--dest ephemeral` (default): read `.xano/ephemeral.json` for the active
 *     tenant, GET it, and create-or-refresh — a live tenant is refreshed (URL
 *     unchanged); a 404/expired one is recreated (URL change is called out).
 *   • `--dest sandbox`: resolve the singleton sandbox (`/api:meta/sandbox/me`)
 *     and import into it. No local state; no URL-change tracking.
 *
 * Nothing the server returns is written back into `xano.lock` — the env is a
 * different, throwaway workspace and reconciling its identities would pollute the
 * lock. (Compiling an ENTRY FILE still maintains the local lock via
 * `exportBundleJson`, unrelated to the deploy.)
 *
 * `--static <dir>` deploys a frontend alongside the backend. Its target depends
 * on the destination: for `--dest ephemeral` it goes to the EPHEMERAL itself (so
 * backend + frontend share one disposable environment); for `--dest sandbox` it
 * goes to the caller's OWN (parent) workspace, since the sandbox tenant does not
 * serve static hosting. Independent of the backend import: a static failure after
 * a committed import exits distinctly.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import type { ParsedArgs } from "./cli.js";
import { loadBundleText } from "./bundle-input.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { encodeWorkspaceArchive } from "../validate/archive.js";
import { importWorkspaceArchive } from "../deploy/import.js";
import {
  createEphemeral,
  getEphemeral,
  waitUntilReady,
  isExpired,
  tenantBaseUrl,
  type EphemeralSummary,
} from "../deploy/ephemeral.js";
import { readEphemeralState, getEnvironment, setEnvironment } from "../deploy/ephemeral-state.js";
import { resolveScopedWorkspaceId } from "../deploy/workspace.js";
import { step, success, warn, detail, info, link, formatExpiration } from "./ui.js";
import { basename } from "node:path";

/** Exit code for a post-commit static failure (the backend import itself succeeded). */
const EXIT_STATIC_FAILED = 3;
/** Metadata fetch bound for `sandbox/me`, matching the other meta reads. */
const SANDBOX_TIMEOUT_MS = 30_000;

/** Deploy destination. */
export type DeployDest = "sandbox" | "ephemeral";

interface DeploySummary {
  dest: DeployDest;
  url: string | undefined;
  ephemeral?: { name: string; display: string | undefined; expiresAt: string | number | undefined };
  created?: boolean;
  static?: { url: string | undefined; verified?: boolean };
}

/**
 * Build the static-host config globals: the backend URL is seeded as `XANO_HOST`,
 * then the caller's `--static-env` pairs override/extend it. Exported for tests.
 */
export function buildStaticEnv(baseUrl: string | undefined, staticEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  if (baseUrl) env.XANO_HOST = baseUrl;
  Object.assign(env, staticEnv);
  return env;
}

/**
 * Best-effort display name for an auto-created ephemeral: the workspace name
 * baked into the compiled bundle, else the project directory basename.
 */
export function deriveDisplay(bundleText: string, cwd: string): string {
  try {
    // `payload.workspace` is the workspace settings object (`{ name, ... }`);
    // tolerate an array shape defensively.
    const parsed = JSON.parse(bundleText) as { payload?: { workspace?: unknown } };
    const w = parsed.payload?.workspace;
    const name = Array.isArray(w)
      ? (w[0] as { name?: unknown } | undefined)?.name
      : (w as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.trim() !== "") return name;
  } catch {
    /* fall through to the directory name */
  }
  return basename(cwd) || "sidestep-app";
}

/** Resolve the sandbox's base URL via get-or-create `sandbox/me`. */
async function resolveSandboxBaseUrl(auth: ResolvedAuth): Promise<string> {
  const url = new URL("/api:meta/sandbox/me", auth.instance);
  const res = await fetch(url.href, {
    headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
    signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`resolve sandbox failed (${res.status} ${res.statusText}):\n${text}`);
  let tenant: Record<string, unknown> = {};
  try {
    tenant = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`resolve sandbox: could not parse the ${url.pathname} response as JSON:\n${text}`);
  }
  return tenantBaseUrl(tenant, auth.instance);
}

export async function runDeployCommand(args: ParsedArgs): Promise<void> {
  const dest: DeployDest = args.dest ?? "ephemeral";

  // `--reset` is accepted but a no-op: every deploy is a full replace now.
  if (args.reset) info("`--reset` is redundant — deploy is always a full replace.");

  const { bundle, source, content } = await loadBundleText(
    args,
    `Missing input. Usage: sidestep deploy [--dest sandbox|ephemeral] <file> | --bundle <path>.`,
    { withSeed: true },
  );

  const auth = await getAccessToken(args);
  if (content.length > 0) {
    const rows = content.length === 1 ? "1 seed content file" : `${content.length} seed content files`;
    detail(`Bundling ${rows} (full replace re-seeds cleanly).`);
  }
  const archive = encodeWorkspaceArchive(bundle, content);

  const summary: DeploySummary =
    dest === "sandbox"
      ? await deploySandbox(auth, archive, source)
      : await deployEphemeral(auth, { archive, bundle, source, args });

  if (args.static !== undefined) {
    const env = buildStaticEnv(summary.url, args.staticEnv);
    const explicit = Object.keys(args.staticEnv).length > 0;
    // Static-host target depends on the destination:
    //   • ephemeral → the ephemeral itself (its base URL, workspace id 1), so
    //     backend AND frontend live in the same disposable environment.
    //   • sandbox   → the caller's PARENT workspace (the sandbox tenant does not
    //     serve static hosting), resolved from the token.
    const target: StaticTarget =
      dest === "ephemeral" && summary.url !== undefined
        ? { baseUrl: summary.url, workspaceId: 1, label: `ephemeral ${summary.ephemeral?.name ?? ""}`.trim() }
        : { baseUrl: auth.instance, workspaceId: await resolveScopedWorkspaceId(auth), label: undefined };
    try {
      summary.static = await deployStaticTo(args.static, auth, target, env, explicit, args.staticHost, args.noVerify);
    } catch (err) {
      warn("Backend deployed, but the static-host upload failed:");
      detail(err instanceof Error ? err.message : String(err));
      detail(
        `Retry just the static step: sidestep deploy --static ${args.static}` +
          (args.staticHost ? ` --static-host ${args.staticHost}` : ""),
      );
      process.exitCode = EXIT_STATIC_FAILED;
    }
  }

  // stdout is the machine-readable data channel: emit the projected, secret-free
  // summary as JSON when it's piped or redirected. On an interactive terminal the
  // progress lines already carry the URL, so a raw dump would just be noise.
  if (!process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }
}

async function deploySandbox(auth: ResolvedAuth, archive: Uint8Array, source: string): Promise<DeploySummary> {
  step(`Deploying ${source} → sandbox (full replace)`);
  const baseUrl = await resolveSandboxBaseUrl(auth);
  await importWorkspaceArchive(auth, { baseUrl, archive });
  success("Backend deployed to sandbox");
  link(baseUrl);
  return { dest: "sandbox", url: baseUrl };
}

async function deployEphemeral(
  auth: ResolvedAuth,
  ctx: { archive: Uint8Array; bundle: string; source: string; args: ParsedArgs },
): Promise<DeploySummary> {
  const { archive, bundle, source, args } = ctx;
  // The parent workspace is where the ephemeral is *created*: the one the
  // credential is bound to, never a hard-coded 1 (instances number workspaces
  // from their own sequence, so a fixed 1 404s "Invalid workspace" anywhere the
  // first workspace isn't 1) and never a flag.
  const parentWorkspaceId = auth.workspaceId;
  // Ephemeral state is ALWAYS the project directory, never the global cache —
  // even when auth came from the shared global cache. That's deliberate: it keys the active
  // ephemeral to the folder you're deploying from, so different projects (and
  // parallel deploys) each track their own environment independently.
  const dir = process.cwd();
  const stored = getEnvironment(readEphemeralState(dir), parentWorkspaceId);

  // Decide refresh (existing, live) vs. create (none tracked, or gone/expired).
  let target: EphemeralSummary | null = null;
  if (stored) {
    const existing = await getEphemeral(auth, { parentWorkspaceId, name: stored.name });
    if (existing && !isExpired(existing.expiresAt)) target = existing;
  }
  const created = target === null;

  if (target === null) {
    const display = args.name ?? deriveDisplay(bundle, dir);
    step(`Deploying ${source} → new ephemeral "${display}"`);
    const fresh = await createEphemeral(auth, { parentWorkspaceId, display, expiresHours: args.expiresHours });
    detail(`Waiting for ${fresh.name} to become ready…`);
    target = await waitUntilReady(auth, { parentWorkspaceId, name: fresh.name });
  } else {
    step(`Deploying ${source} → ephemeral ${target.name} (refresh, full replace)`);
  }

  const baseUrl = target.url;
  if (baseUrl === undefined) {
    throw new Error(`Ephemeral "${target.name}" has no base URL yet — try \`sidestep deploy\` again.`);
  }

  // Persist BEFORE import so an import failure still leaves a pointer the next
  // deploy can refresh rather than leaking a fresh tenant.
  setEnvironment(dir, parentWorkspaceId, {
    name: target.name,
    display: target.display ?? args.name ?? target.name,
    url: baseUrl,
    expires_at: target.expiresAt,
  });

  await importWorkspaceArchive(auth, { baseUrl, archive });

  const urlChanged = created || (stored !== undefined && stored.url !== baseUrl);
  if (urlChanged) {
    success(`Ephemeral ${target.name} deployed`);
    warn("New ephemeral URL:");
    link(baseUrl);
  } else {
    success(`Refreshed ${target.name} (URL unchanged)`);
    link(baseUrl);
  }
  detail(`Expires ${formatExpiration(target.expiresAt)}`);
  // `target.name` (the tenant handle, e.g. `ewap-8wz9-9e13`) — NOT the display —
  // is what `ephemeral get/delete/export` take, so spell out the handle to use.
  detail(`Manage with \`sidestep ephemeral get ${target.name}\``);

  return {
    dest: "ephemeral",
    url: baseUrl,
    ephemeral: { name: target.name, display: target.display, expiresAt: target.expiresAt },
    created,
  };
}

/** Where a static frontend is uploaded: an env base URL + workspace id, with a display label. */
export interface StaticTarget {
  baseUrl: string;
  workspaceId: number;
  /** Human label for the progress line (e.g. `ephemeral e4f2`); falls back to `workspace #id`. */
  label: string | undefined;
}

/**
 * Archive `dir` and deploy it to a static host on the given target (env base URL
 * + workspace id). `deploy` points this at the ephemeral itself or the parent
 * workspace per destination; `release` reuses it for the instance workspace.
 */
export async function deployStaticTo(
  dir: string,
  auth: ResolvedAuth,
  target: StaticTarget,
  env: Record<string, string>,
  explicit: boolean,
  host?: string,
  noVerify?: boolean,
): Promise<DeploySummary["static"]> {
  const { deployStaticHost } = await import("../deploy/static-host.js");

  const where = target.label && target.label !== "" ? target.label : `workspace #${target.workspaceId}`;
  step(`Deploying static frontend ${dir} → ${where}${host ? ` (host: ${host})` : ""}`);
  const sh = await deployStaticHost({ host, dir, workspaceId: target.workspaceId, baseUrl: target.baseUrl, accessToken: auth.access_token, env });

  const globals = Object.keys(env).map((k) => `window.${k}`);
  if (globals.length > 0) {
    if (sh.envInjected) success(`Config injected into index.html: ${globals.join(", ")}`);
    else if (explicit) warn(`Config not injected — no <head> in a root index.html to anchor to. ${globals.join(", ")} unset.`);
    else detail(`No root index.html to inject window.XANO_HOST into — skipped.`);
  }

  success("Static host deployed");
  if (sh.url) link(sh.url);

  // Confirm the edge is serving THIS build before calling it done. The build POST
  // 200 only means the archive was ingested — a cold pod can still 503 and a
  // redeploy can route the previous build for a window. Poll `X-Xano-Canonical`
  // until it matches this build's canonical. Skipped (and reported as before)
  // when opted out, when there's no URL to poll, or when the response carried no
  // canonical to compare against (older engine / unexpected shape).
  if (noVerify || sh.url === undefined || sh.canonical === undefined) {
    return { url: sh.url };
  }
  const { verifyRollout } = await import("../deploy/verify-rollout.js");
  step("Verifying the frontend is live…");
  const { live } = await verifyRollout(sh.url, sh.canonical);
  if (live) {
    success("Frontend is live");
  } else {
    // Not a failure: the build uploaded fine, the edge just hasn't confirmed it
    // in time (a slow cold pod usually serves moments later). Warn, record it in
    // the summary, and leave the exit code untouched.
    warn("Could not confirm the frontend is live within the wait window — the build uploaded and should come online shortly.");
    detail(`Re-check by opening ${sh.url}, or skip this wait next time with --no-verify.`);
  }
  return { url: sh.url, verified: live };
}
