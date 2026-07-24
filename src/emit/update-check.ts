/**
 * Best-effort "a newer @sidestep/core is on npm" notifier for the CLI.
 *
 * Runs only from the real `bin.ts` executable (never from the programmatic
 * `run()` the tests drive), so `run()` stays pure and network-free. The notice
 * goes to STDERR — stdout is a clean data channel (`export`/`compile` bundles),
 * so a nagline can never corrupt a piped artifact.
 *
 * Cheap by construction: the latest version is cached to
 * `~/.sidestep/update-check.json` and only re-fetched once per {@link CHECK_INTERVAL_MS},
 * so almost every invocation is an offline cache read that adds no latency. The
 * one daily network call is bounded by {@link FETCH_TIMEOUT_MS} and swallows every
 * error — a slow, offline, or down registry must never delay or fail a command.
 *
 * Opt out with `SIDESTEP_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` (the de-facto
 * convention), and it stays silent under `CI` or when stderr is not a TTY so it
 * never spams logs. Node-only; never reachable from the browser-safe `index.ts`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { atomicWrite } from "../util/atomic-write.js";
import { readVersion } from "./cli.js";
import { style, warn, detail, blank } from "./ui.js";

/** npm registry endpoint for the latest published manifest (overridable for tests). */
function registryUrl(): string {
  return (
    process.env.SIDESTEP_UPDATE_REGISTRY ?? "https://registry.npmjs.org/@sidestep/core/latest"
  );
}

/** Cache location (overridable for tests): `~/.sidestep/update-check.json`. */
function cachePath(): string {
  return process.env.SIDESTEP_UPDATE_CACHE ?? join(homedir(), ".sidestep", "update-check.json");
}

/**
 * Re-hit the registry at most once an hour; otherwise serve the cached answer.
 * Short by design — we publish often during rapid prototyping, so a stale nudge
 * should never lag a release by more than an hour.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Bound the registry fetch so a stalled endpoint can't hang the CLI. */
const FETCH_TIMEOUT_MS = 2_000;

interface Cache {
  /** The `latest` dist-tag version last seen on the registry. */
  latest: string;
  /** Epoch ms of that fetch — drives the {@link CHECK_INTERVAL_MS} staleness gate. */
  checkedAt: number;
}

/** An available upgrade: what's installed vs. what npm's `latest` tag points at. */
export interface UpdateNotice {
  current: string;
  latest: string;
}

/**
 * Compare two `x.y.z[-pre.n]` versions, returning true when `candidate` is a
 * strict upgrade over `current`. A tiny, dependency-free semver precedence: a
 * released version outranks any prerelease of the same `x.y.z`, and prerelease
 * identifiers compare per semver (numeric < alphanumeric, more fields wins).
 * Unparseable input returns false — we never nag on a version we can't reason
 * about (e.g. a git build or `readVersion()`'s `"unknown"`).
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i]! !== b.nums[i]!) return a.nums[i]! > b.nums[i]!;
  }
  // Equal x.y.z: a release (no prerelease) is newer than a prerelease; two
  // releases are equal (not newer); otherwise compare prerelease identifiers.
  if (a.pre.length === 0) return b.pre.length > 0;
  if (b.pre.length === 0) return false;
  return comparePre(a.pre, b.pre) > 0;
}

function parseSemver(v: string): { nums: [number, number, number]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Semver prerelease precedence: numeric ids sort below alphanumeric; more fields wins. */
function comparePre(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // fewer fields → lower precedence
    if (i >= b.length) return 1;
    const x = a[i]!;
    const y = b[i]!;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers have lower precedence
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function readCache(): Cache | undefined {
  const path = cachePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Cache>;
    if (typeof parsed.latest === "string" && typeof parsed.checkedAt === "number") {
      return { latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    /* corrupt cache — treat as absent and re-fetch */
  }
  return undefined;
}

function writeCache(cache: Cache): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWrite(path, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    /* an unwritable cache just means we re-check next run — never fatal */
  }
}

/** Fetch npm's `latest` version, or null on any failure (offline, timeout, 4xx/5xx). */
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(registryUrl(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/** True when the user or environment has turned the notifier off. */
function disabled(): boolean {
  return Boolean(
    process.env.SIDESTEP_NO_UPDATE_CHECK ||
      process.env.NO_UPDATE_NOTIFIER ||
      process.env.CI,
  );
}

/**
 * Resolve whether an upgrade is available, consulting (and refreshing) the cache.
 * Returns null when up to date, disabled, or the version can't be determined.
 * `force` bypasses the environment/TTY gates for tests. Never throws.
 */
export async function resolveUpdateNotice(opts?: {
  current?: string;
  force?: boolean;
}): Promise<UpdateNotice | null> {
  if (!opts?.force && disabled()) return null;
  const current = opts?.current ?? readVersion();
  if (current === "unknown") return null; // nothing to compare against

  const cache = readCache();
  let latest = cache?.latest;
  const now = Date.now();
  if (!cache || now - cache.checkedAt > CHECK_INTERVAL_MS) {
    const fetched = await fetchLatest();
    if (fetched) {
      latest = fetched;
      writeCache({ latest: fetched, checkedAt: now });
    }
    // On a failed fetch we fall back to the (stale) cached `latest`, if any —
    // a transient outage shouldn't suppress a notice we already know about.
  }

  return latest && isNewer(latest, current) ? { current, latest } : null;
}

/**
 * Whether this CLI is a project-local dependency or a global install — so the
 * nudge suggests the matching upgrade command. We resolve `@sidestep/core` from
 * the user's CWD: if their project depends on it the resolve succeeds (a local
 * `-D` upgrade is right); if it doesn't, the running CLI must be the global
 * install, so `-g` is right. Dependency-free and spawn-free (no `npm root -g`).
 * `SIDESTEP_INSTALL_MODE` overrides it (tests, or a user who wants to pin the
 * suggestion). Any unexpected error falls back to `global` — the safe default,
 * since suggesting `-g` to a local-dep user is a no-op they'll notice, whereas
 * suggesting `-D` to a global user would wrongly add a stray project dependency.
 */
export function detectInstallMode(): "global" | "local" {
  const override = process.env.SIDESTEP_INSTALL_MODE;
  if (override === "global" || override === "local") return override;
  try {
    const requireFromCwd = createRequire(join(process.cwd(), "package.json"));
    requireFromCwd.resolve("@sidestep/core/package.json");
    return "local";
  } catch {
    return "global";
  }
}

/** The `npm install` line that upgrades an install of the given kind. */
export function upgradeCommand(mode: "global" | "local"): string {
  return mode === "global"
    ? "npm i -g @sidestep/core@latest"
    : "npm i -D @sidestep/core@latest";
}

/** Print the two-line upgrade nudge to stderr, styled but color-safe. */
export function printUpdateNotice(notice: UpdateNotice): void {
  blank();
  warn(
    `A new @sidestep/core is available: ${style.dim(notice.current)} → ${style.green(notice.latest)}`,
  );
  detail(`update: ${upgradeCommand(detectInstallMode())}`);
}

/**
 * Best-effort end-of-run hook: notify iff an upgrade is available and the
 * notifier is enabled (interactive, non-CI, not opted out). Swallows everything
 * so it can never turn a successful command into a failure.
 */
export async function maybeNotifyUpdate(): Promise<void> {
  try {
    if (disabled() || process.stderr.isTTY !== true) return;
    const notice = await resolveUpdateNotice();
    if (notice) printUpdateNotice(notice);
  } catch {
    /* a notifier must never break the CLI */
  }
}
