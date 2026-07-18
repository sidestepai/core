/**
 * Node-only atomic file write: stage into a per-pid temp file, then rename into
 * place, so a crash can never leave a half-written file. Shared by the lock I/O
 * (`src/lock/io.ts`) and the OAuth token cache (`src/auth/store.ts`) — the one
 * place this crash-safety dance is defined, so the two can't drift.
 *
 * Reachable only from Node-only modules; never pulled into the browser-safe
 * `index.ts` surface.
 */
import { writeFileSync, renameSync, rmSync } from "node:fs";

/** Write `contents` to `path` atomically. Pass `mode` for restrictive perms (e.g. 0o600). */
export function atomicWrite(path: string, contents: string, opts?: { mode?: number }): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, contents, opts?.mode !== undefined ? { encoding: "utf8", mode: opts.mode } : "utf8");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
