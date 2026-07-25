/**
 * Node-only local project state for the active ephemeral environment, so
 * `sidestep deploy` can *refresh* the one you're iterating on instead of leaking
 * a fresh tenant every run. Stored at `./.xano/ephemeral.json`, keyed by the
 * numeric PARENT workspace id (a project can target more than one), holding just
 * the handle needed to find + compare the env next time.
 *
 * Deliberately separate from `xano.lock` (identity) and `.xano/auth.json`
 * (credentials): different lifecycle, different meaning, and it carries no
 * secrets. The write mirrors `src/lock/io.ts` / `src/auth/store.ts` (temp-file +
 * rename via `atomicWrite`, recursive mkdir, and a `.xano/` gitignore entry).
 *
 * State is a hint, never truth: a deploy always re-`GET`s the tenant and treats
 * a 404 / past expiry as "create a new one", so a stale or corrupt file can
 * never block a deploy — reads fall back to empty rather than throwing.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { ensureGitignored } from "../auth/store.js";

/** The tracked handle for one ephemeral env (never secrets). */
export interface EphemeralRecord {
  /** Server-assigned tenant name — the stable handle used to GET/import/delete. */
  name: string;
  /** Human display name shown at create time. */
  display: string;
  /** The env's public base URL (`xano_domain`), compared run-to-run to flag URL changes. */
  url: string;
  /** Expiry as the API serializes it (`"2026-07-24 20:49:15+0000"`), or a unix-epoch number. */
  expires_at: string | number | undefined;
}

/** The on-disk file: active ephemeral per parent workspace id. */
export interface EphemeralState {
  version: 1;
  environments: Record<string, EphemeralRecord>;
}

const EMPTY: EphemeralState = { version: 1, environments: {} };

/** `./.xano/ephemeral.json` resolved against a project directory. */
export function ephemeralStatePath(dir: string): string {
  return join(resolve(dir), ".xano", "ephemeral.json");
}

/**
 * Read the state file. A missing OR unparseable/invalid file yields empty state
 * (never a throw) — a bad state file must not block a deploy; it's recreated on
 * the next write.
 */
export function readEphemeralState(dir: string): EphemeralState {
  const path = ephemeralStatePath(dir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { version: 1, environments: {} };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as EphemeralState).environments === "object") {
      const envs = (parsed as EphemeralState).environments ?? {};
      return { version: 1, environments: { ...envs } };
    }
  } catch {
    /* fall through to empty */
  }
  return { version: 1, environments: {} };
}

/** The tracked ephemeral for a parent workspace id, or `undefined`. */
export function getEnvironment(state: EphemeralState, workspaceId: number | string): EphemeralRecord | undefined {
  return state.environments[String(workspaceId)];
}

/** Upsert the tracked ephemeral for a parent workspace id and persist atomically. */
export function setEnvironment(dir: string, workspaceId: number | string, record: EphemeralRecord): void {
  const state = readEphemeralState(dir);
  state.environments[String(workspaceId)] = record;
  writeState(dir, state);
}

/** Remove the tracked ephemeral for a parent workspace id. Returns whether one was removed. */
export function clearEnvironment(dir: string, workspaceId: number | string): boolean {
  const state = readEphemeralState(dir);
  if (!(String(workspaceId) in state.environments)) return false;
  delete state.environments[String(workspaceId)];
  writeState(dir, state);
  return true;
}

function writeState(dir: string, state: EphemeralState): void {
  const path = ephemeralStatePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify({ version: 1, environments: state.environments }, null, 2) + "\n");
  ensureGitignored(path);
}
