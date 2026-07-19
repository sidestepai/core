/**
 * Reconcile a deploy endpoint's authoritative post-import lock into the local
 * `xano.lock`. The backend is the identity authority (canonical uniqueness is
 * instance-wide, and guid-matched updates keep the server's canonical), so after
 * a deploy the server's returned lock is the truth the local file should track.
 *
 * Browser-safe and pure (no `node:*`): the write-back itself lives in the Node
 * command layer (`writeLockFile`), this module only computes the reconciled
 * model. Reconciliation is **best-effort by design** — it runs AFTER an
 * irreversible deploy has committed, so an unusable server lock must never turn
 * a successful deploy into a failure. Unusable input yields a `skip` outcome the
 * caller surfaces as a warning + distinct exit code, not a throw (an explicit
 * exception to the export path's fatal-broken-lock rule).
 */
import {
  LOCK_VERSION,
  WORKSPACE_KEY,
  WORKSPACE_REALTIME_KEY,
  validateLockModel,
  type LockEntry,
  type LockFile,
} from "./lock.js";

export interface ReconcileOptions {
  /** `--reset`: the workspace is exactly the bundle, so replace the lock wholesale
   *  (local-only orphan entries are provably dead). Default is a server-wins merge. */
  reset?: boolean;
  /** `--adopt-workspace`: accept the server's workspace-canonical keys even when they
   *  differ locally (rebind), instead of refusing on the project↔workspace mismatch guard. */
  adoptWorkspace?: boolean;
}

export type ReconcileOutcome =
  /** The reconciled lock is ready to write. */
  | { status: "ok"; lock: LockFile }
  /** The server lock could not be used (unknown version/kind/key, or the merge would
   *  violate a model invariant). Non-fatal: skip write-back, warn, distinct exit code. */
  | { status: "skip"; reason: string }
  /** A workspace-canonical key differs between local and server and `--adopt-workspace`
   *  was not passed: the project is likely pointed at a different workspace. */
  | { status: "workspace-mismatch"; key: string; local: string; server: string };

/** The fixed workspace-identity keys, guarded against silent server-wins overwrite. */
const WORKSPACE_KEYS: readonly string[] = [WORKSPACE_KEY, WORKSPACE_REALTIME_KEY];

/**
 * Coerce a raw server lock (a JSON value off the deploy response) into a validated
 * `LockFile`, or an error string. Version negotiation lives here: a version newer
 * than this CLI understands is a skip, not a hard failure.
 */
function coerceServerLock(raw: unknown): { lock: LockFile } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "server lock is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
    return { error: "server lock has no integer `version`" };
  }
  if (obj.version > LOCK_VERSION) {
    return {
      error: `server lock version ${obj.version} is newer than this CLI understands (${LOCK_VERSION}) — upgrade sidestep to reconcile`,
    };
  }
  if (obj.version < 1) {
    return { error: `server lock version ${obj.version} is invalid` };
  }
  if (!obj.objects || typeof obj.objects !== "object" || Array.isArray(obj.objects)) {
    return { error: "server lock has no `objects` map" };
  }
  const candidate: LockFile = { version: LOCK_VERSION, objects: obj.objects as Record<string, LockEntry> };
  try {
    // Reuse the on-disk model invariants (key shape, entry shape, no duplicate
    // guid/canonical). A server lock the local `parseLock` would reject is unusable.
    validateLockModel(candidate, "the server lock");
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { lock: cleanLock(candidate) };
}

/** Keep only the identity fields, so a reconciled write never carries stray server-side keys. */
function cleanLock(lock: LockFile): LockFile {
  const objects: Record<string, LockEntry> = {};
  for (const [key, entry] of Object.entries(lock.objects)) {
    const clean: LockEntry = {};
    if (typeof entry.guid === "string") clean.guid = entry.guid;
    if (typeof entry.canonical === "string") clean.canonical = entry.canonical;
    objects[key] = clean;
  }
  return { version: LOCK_VERSION, objects };
}

/**
 * Merge the server's authoritative lock into the local one.
 *
 * - Default (`reset: false`): server wins per key, local-only entries preserved.
 * - `reset: true`: replace wholesale — after a full clear the workspace *is* the
 *   bundle, so local-only entries reference cleared objects.
 * - Workspace keys are the server-wins exception: a differing value refuses
 *   (returns `workspace-mismatch`) unless `adoptWorkspace` rebinds it.
 */
export function reconcileServerLock(
  local: LockFile,
  serverRaw: unknown,
  opts: ReconcileOptions = {},
): ReconcileOutcome {
  const coerced = coerceServerLock(serverRaw);
  if ("error" in coerced) return { status: "skip", reason: coerced.error };
  const server = coerced.lock;

  if (!opts.adoptWorkspace) {
    for (const key of WORKSPACE_KEYS) {
      const localVal = local.objects[key]?.canonical;
      const serverVal = server.objects[key]?.canonical;
      if (localVal !== undefined && serverVal !== undefined && localVal !== serverVal) {
        return { status: "workspace-mismatch", key, local: localVal, server: serverVal };
      }
    }
  }

  const objects: Record<string, LockEntry> = opts.reset
    ? { ...server.objects }
    : { ...local.objects, ...server.objects };

  const merged: LockFile = { version: LOCK_VERSION, objects };
  try {
    // A stale local-only entry can collide with a server-regenerated canonical
    // (e.g. an in-code rename not yet reflected locally); best-effort skip rather
    // than fail the already-committed deploy.
    validateLockModel(merged, "the reconciled lock");
  } catch (err) {
    return { status: "skip", reason: err instanceof Error ? err.message : String(err) };
  }
  return { status: "ok", lock: merged };
}
