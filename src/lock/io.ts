/**
 * Node-only lock-file I/O. Kept out of `lock.ts` (which stays browser-safe: the
 * pure lock model is reachable from the authoring surface) so importing a
 * workspace def in a frontend bundle never pulls in `node:fs`. Reachable only
 * through the `@sidestep/core/node` entry, the CLI, and lock-command tooling.
 */
import { readFileSync, existsSync } from "node:fs";
import { atomicWrite } from "../util/atomic-write.js";
import { parseLock, serializeLock, type LockFile } from "./lock.js";

/** Read + strictly validate a lock file from disk. The file must exist. */
export function readLockFile(path: string): LockFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read lock file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseLock(text, path);
}

/**
 * Atomic, idempotent write: unchanged bytes are not rewritten (mtime stays
 * put, watchers stay quiet); changed content lands via temp-file+rename so a
 * crash can never leave a half-written lock.
 *
 * Returns true when the file was (re)written.
 */
export function writeLockFile(path: string, lock: LockFile): boolean {
  const next = serializeLock(lock);
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === next) return false;
    } catch {
      // Unreadable existing file — fall through and replace it.
    }
  }
  atomicWrite(path, next);
  return true;
}
