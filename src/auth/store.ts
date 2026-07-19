/**
 * Node-only token cache for OAuth credentials. Reads/writes a project-local
 * JSON file (default `./.xano/auth.json`) with owner-only permissions, and
 * keeps that file out of git. Never reachable from the browser-safe `index.ts`
 * surface — imported only by the CLI's `login`/`push` command modules.
 *
 * The write mirrors `src/lock/io.ts` `writeLockFile` (temp-file + rename so a
 * crash can't leave a half-written credential file) and adds mode 0600 and a
 * recursive mkdir of the containing directory.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import type { ParsedArgs } from "../emit/cli.js";

/** One instance's cached OAuth credentials. */
export interface TokenRecord {
  access_token: string;
  /** Present only when `offline_access` was granted. Rotated on every refresh. */
  refresh_token?: string;
  /** Epoch milliseconds after which `access_token` must be refreshed. */
  expires_at: number;
  /** Space-separated scopes the token was granted. */
  scope?: string;
  /** Instance origin the token is bound to (read from the token's `aud` claim). */
  instance: string;
  /** cloud-master OAuth host the token was minted by (for refresh). */
  auth_host: string;
  /** OAuth client_id the token was minted under — required to refresh it. */
  client_id: string;
}

/** Default project-local cache path. Resolved against the current directory. */
const DEFAULT_AUTH_FILE = join(".xano", "auth.json");

/**
 * Resolve the token cache path: `--config` → `$XANO_CONFIG` → the
 * project-local default `./.xano/auth.json`. Mirrors the flag→env→default
 * precedence used elsewhere in the CLI.
 */
export function resolveAuthFilePath(args: ParsedArgs): string {
  const raw = args.authFile ?? process.env.XANO_CONFIG ?? DEFAULT_AUTH_FILE;
  return resolve(raw);
}

/**
 * Read the cached credentials. Returns `null` — not a throw — when the file is
 * absent, so callers can emit an actionable "run `sidestep login`" message rather
 * than surfacing an opaque ENOENT.
 */
export function readTokens(path: string): TokenRecord | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Token cache at ${path} is corrupt (invalid JSON). Delete it and run \`sidestep login\` again.`,
    );
  }
  if (!isTokenRecord(parsed)) {
    throw new Error(
      `Token cache at ${path} is missing expected fields. Delete it and run \`sidestep login\` again.`,
    );
  }
  return parsed;
}

/** Minimal structural check that a parsed value is a token record. */
function isTokenRecord(v: unknown): v is TokenRecord {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as TokenRecord).access_token === "string" &&
    typeof (v as TokenRecord).instance === "string"
  );
}

/**
 * Atomically write the credentials with owner-only permissions. Content is
 * staged in a per-pid temp file (created mode 0600) and renamed into place, so
 * a crash never leaves a half-written or world-readable credential file.
 */
export function writeTokens(path: string, tokens: TokenRecord): void {
  // Guard against an `--config` typo clobbering an unrelated file (e.g.
  // package.json): if the target already exists, it must already be a token
  // cache before we overwrite it.
  if (existsSync(path)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      existing = undefined;
    }
    if (!isTokenRecord(existing)) {
      throw new Error(
        `Refusing to overwrite ${path}: it exists but is not a sidestep token cache. ` +
          `Choose a different --config/$XANO_CONFIG path.`,
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Delete the token cache (logout). Returns true when a file was removed, false
 * when there was nothing to remove. Refuses to delete a file that isn't a
 * sidestep token cache, so a `--config` typo can't `rm` an unrelated file.
 */
export function clearTokens(path: string): boolean {
  if (!existsSync(path)) return false;
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    existing = undefined;
  }
  if (!isTokenRecord(existing)) {
    throw new Error(
      `Refusing to delete ${path}: it exists but is not a sidestep token cache. ` +
        `Choose a different --config/$XANO_CONFIG path.`,
    );
  }
  rmSync(path);
  return true;
}

/** Walk up from `startDir` to the nearest directory containing a `.git` entry. */
function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Ensure the token file is ignored by git. Appends an entry to the project's
 * `.gitignore` (creating it if absent) when no existing rule already covers the
 * file. Idempotent. Returns true when `.gitignore` was modified.
 *
 * The entry is the file's containing directory (e.g. `.xano/`) when that dir is
 * below the git root, otherwise the bare filename — so a dedicated `.xano/`
 * cache is ignored wholesale while a root-level custom `--config` ignores
 * just that file. A token file outside the repo tree (e.g. under $HOME) is left
 * alone: there is nothing to gitignore.
 */
export function ensureGitignored(authFilePath: string): boolean {
  const abs = resolve(authFilePath);
  const root = findGitRoot(dirname(abs)) ?? process.cwd();

  // A cache outside the repo (or outside $HOME-anchored trees) needs no ignore.
  const rel = relative(root, abs);
  if (rel.startsWith("..")) return false;

  const containingDir = dirname(abs);
  const entry =
    containingDir === root
      ? relForwardSlash(root, abs) // root-level file → ignore the file itself
      : relForwardSlash(root, containingDir) + "/"; // dedicated dir → ignore the dir

  const gitignorePath = join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (ignoreCovers(existing, entry)) return false;

  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : existing + "\n";
  writeFileSync(gitignorePath, `${prefix}${entry}\n`, "utf8");
  return true;
}

/** Path of `target` relative to `root`, always forward-slashed (gitignore style). */
function relForwardSlash(root: string, target: string): string {
  return relative(root, target).split(/[\\/]/).join("/");
}

/** Does an existing `.gitignore` already ignore `entry` (slash-insensitive)? */
function ignoreCovers(gitignore: string, entry: string): boolean {
  const want = entry.replace(/\/$/, "");
  return gitignore
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/$/, ""))
    .some((line) => line.length > 0 && !line.startsWith("#") && line === want);
}
