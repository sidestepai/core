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
import type { NonPublicSeedValue } from "../workspace/seed.js";
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
import {
  waitForMicroservices,
  type MicroserviceSummary,
  type WaitOptions,
} from "../deploy/microservice-status.js";
import { microserviceLine, readyRatio } from "./microservice-view.js";
import { step, success, warn, detail, info, link, spinner, withSpinner, formatExpiration } from "./ui.js";
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
  /** Present only when the deployed workspace declared microservices. */
  microservices?: MicroserviceSummary[];
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

/**
 * Refuse to publish a static build that carries seed values the schema declares
 * non-public (issue #204).
 *
 * Deploy is the one moment both halves are in hand — the rows about to be
 * imported and the assets about to be served — so this is the only place the
 * check can be made without being told about both separately.
 *
 * Only `access: "internal"` and `sensitive: true` columns are considered. A
 * public column's seed value is already readable through the deployed API, so
 * finding it in a bundle is not a disclosure, and refusing on it would train
 * people to reach for the override.
 */
async function assertNoSeedLeaks(
  dir: string,
  values: readonly NonPublicSeedValue[],
  allow: boolean,
): Promise<void> {
  if (values.length === 0) return;
  // Lazily imported for the same reason the upload is: the static-host module
  // pulls in node:fs/node:zlib and must stay out of the authoring bundle.
  const { findSeedLeaks } = await import("../deploy/static-host.js");
  const leaks = findSeedLeaks(dir, values);
  if (leaks.length === 0) return;

  const lines = leaks.map((l) => `  ${l.file} — ${l.table}.${l.column}`);
  if (allow) {
    warn(`Publishing ${leaks.length} non-public seed value(s) in the static build (--allow-seed-in-static):`);
    for (const line of lines) detail(line);
    return;
  }
  throw new Error(
    `Refusing to publish: the static build in "${dir}" contains seed values from columns ` +
      `your schema marks non-public. These would be served at a public URL.\n` +
      `${lines.join("\n")}\n\n` +
      `A bundler copied them in — most often from \`seed: () => import("./seed.json")\`, which ` +
      `does NOT keep seed values out of a frontend build. Use \`seedFile("./seed.json", ` +
      `import.meta.url)\` instead, then rebuild the frontend.\n` +
      `If the data is deliberately public demo content, pass --allow-seed-in-static.`,
  );
}

export async function runDeployCommand(args: ParsedArgs): Promise<void> {
  const dest: DeployDest = args.dest ?? "ephemeral";

  // `--reset` is accepted but a no-op: every deploy is a full replace now.
  if (args.reset) info("`--reset` is redundant — deploy is always a full replace.");

  const { bundle, source, content, nonPublicSeedValues } = await loadBundleText(
    args,
    `Missing input. Usage: sidestep deploy [--dest sandbox|ephemeral] <file> | --bundle <path>.`,
    { withSeed: true },
  );

  // Before ANY network call: a refusal here must leave nothing deployed.
  if (args.static !== undefined) {
    await assertNoSeedLeaks(args.static, nonPublicSeedValues, args.allowSeedInStatic);
  }

  const auth = await getAccessToken(args);
  if (content.length > 0) {
    const rows = content.length === 1 ? "1 seed content file" : `${content.length} seed content files`;
    detail(`Bundling ${rows} (full replace re-seeds cleanly).`);
  }
  const archive = encodeWorkspaceArchive(bundle, content);

  const summary: DeploySummary =
    dest === "sandbox"
      ? await deploySandbox(auth, archive, source, args.noVerify)
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

async function deploySandbox(
  auth: ResolvedAuth,
  archive: Uint8Array,
  source: string,
  noVerify: boolean,
): Promise<DeploySummary> {
  step(`Deploying ${source} → sandbox (full replace)`);
  const baseUrl = await resolveSandboxBaseUrl(auth);
  await withSpinner(IMPORTING_LABEL, () => importWorkspaceArchive(auth, { baseUrl, archive }));
  success("Backend deployed to sandbox");
  link(baseUrl);
  const microservices = await verifyMicroservices(auth, baseUrl, noVerify);
  return { dest: "sandbox", url: baseUrl, ...(microservices ? { microservices } : {}) };
}

/** The wait's opening label, before any read has said how many there are. */
const WAITING_LABEL = "Waiting for microservices…";
/** Shown while the import request is in flight — the deploy's longest silent leg. */
const IMPORTING_LABEL = "Uploading and importing the workspace…";

/**
 * The spinner's label for a poll that just landed: the readiness ratio, so a long
 * wait shows movement rather than a fixed sentence. Falls back to the bare label
 * when nothing was startable (a ratio out of 0 would only confuse).
 */
function waitingLabel(microservices: MicroserviceSummary[]): string {
  const { ready, startable } = readyRatio(microservices);
  return startable === 0 ? WAITING_LABEL : `${WAITING_LABEL} (${ready}/${startable} ready)`;
}

/**
 * After a committed import, wait for the environment's microservices and report
 * what each one is doing.
 *
 * Prints nothing when the workspace declares none, which is the common case and
 * the reason this costs a single request rather than a visible step. Never
 * fails the deploy: the import has already committed, so an unconfirmed or
 * broken microservice is reported and folded into the summary while the exit
 * code stays with the import — the same posture the static-host rollout check
 * takes. Returns `undefined` when there was nothing to report.
 *
 * Exported for tests.
 */
export async function verifyMicroservices(
  auth: ResolvedAuth,
  baseUrl: string,
  noVerify: boolean,
  waitOpts: WaitOptions = {},
): Promise<MicroserviceSummary[] | undefined> {
  if (noVerify) return undefined;

  // The wait can run for minutes with nothing to print until it settles, so the
  // spinner carries the progress: each poll refreshes the ratio in place, and
  // `stop()` erases the line so only the outcome below survives.
  const spin = spinner(WAITING_LABEL);
  let result;
  try {
    // An env's own internal workspace id is always 1 — the same pair the import
    // just used, so this reads exactly what was written.
    result = await waitForMicroservices(auth, { baseUrl, workspaceId: 1 }, {
      ...waitOpts,
      onPoll: (rows) => {
        spin.update(waitingLabel(rows));
        waitOpts.onPoll?.(rows);
      },
    });
  } catch (err) {
    warn("Could not read microservice status (the backend deployed fine):");
    detail(err instanceof Error ? err.message : String(err));
    return undefined;
  } finally {
    spin.stop();
  }

  const { microservices, timedOut, hadFailure } = result;
  if (microservices.length === 0) return undefined;

  const { ready, startable } = readyRatio(microservices);

  if (hadFailure) {
    warn("Some microservices failed to start:");
  } else if (timedOut) {
    warn(`Microservices are still starting (${ready}/${startable} ready) — they should come up shortly:`);
  } else if (startable === 0) {
    // Every microservice is manual or disabled: nothing was started, and saying
    // "ready (0/0)" would imply otherwise.
    info("No microservices to start:");
  } else {
    success(`Microservices ready (${ready}/${startable})`);
  }
  for (const m of microservices) detail(microserviceLine(m));
  if (timedOut && !hadFailure) {
    detail("Re-check with `sidestep ephemeral get <env>`, or skip this wait next time with --no-verify.");
  }

  return microservices;
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
    target = await withSpinner(`Waiting for ${fresh.name} to become ready…`, () =>
      waitUntilReady(auth, { parentWorkspaceId, name: fresh.name }),
    );
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

  await withSpinner(IMPORTING_LABEL, () => importWorkspaceArchive(auth, { baseUrl, archive }));

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

  const microservices = await verifyMicroservices(auth, baseUrl, args.noVerify);

  return {
    dest: "ephemeral",
    url: baseUrl,
    ephemeral: { name: target.name, display: target.display, expiresAt: target.expiresAt },
    created,
    ...(microservices ? { microservices } : {}),
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
  // Destructured out of `sh` because a closure doesn't keep the narrowing the
  // early return above established on `sh.url`/`sh.canonical`.
  const { url, canonical } = sh;
  const { live } = await withSpinner("Verifying the frontend is live…", () => verifyRollout(url, canonical));
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
