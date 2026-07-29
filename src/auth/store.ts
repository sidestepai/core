/**
 * Node-only credential store for the CLI. Reads/writes a JSON file (the shared
 * `~/.sidestep/auth.json`, or a project-local `./.xano/auth.json`) with
 * owner-only permissions, and keeps that file out of git. Never reachable from
 * the browser-safe `index.ts` surface — imported only by the CLI's command
 * modules.
 *
 * The file holds ONE credential, discriminated by `type`:
 *   • `"oauth"` — written by `sidestep login`; refreshes and rotates.
 *   • `"token"` — hand-authored; a meta-API bearer token plus the instance and
 *     workspace it addresses. Never minted, refreshed, or rotated by the CLI.
 *
 * Both arms pin `workspace_id`, so `(instance, workspace)` is knowable from disk
 * alone and no command needs a runtime workspace lookup.
 *
 * The write mirrors `src/lock/io.ts` `writeLockFile` (temp-file + rename so a
 * crash can't leave a half-written credential file) and adds mode 0600 and a
 * recursive mkdir of the containing directory.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import type { ParsedArgs } from "../emit/cli.js";

/** Credentials minted by `sidestep login` (OAuth 2.1 + PKCE). */
export interface OAuthCredential {
  type: "oauth";
  access_token: string;
  /** Present only when `offline_access` was granted. Rotated on every refresh. */
  refresh_token?: string;
  /** Epoch milliseconds after which `access_token` must be refreshed. */
  expires_at: number;
  /** Space-separated scopes the token was granted. */
  scope?: string;
  /** Instance origin the token is bound to (read from the token's `aud` claim). */
  instance: string;
  /** Numeric workspace the token consented to, pinned at login. */
  workspace_id: number;
  /** Xano control-plane OAuth host the token was minted by (for refresh). */
  auth_host: string;
  /** OAuth client_id the token was minted under — required to refresh it. */
  client_id: string;
}

/**
 * A hand-authored meta-API credential. Carries the same binding an OAuth record
 * does — one instance, one workspace — but the token is opaque, long-lived, and
 * user-managed: the CLI reads it and sends it, never refreshes or revokes it.
 */
export interface TokenCredential {
  type: "token";
  /** Instance origin the meta API is served from, normalized to a bare origin. */
  instance_base_url: string;
  /** Numeric workspace every command acts on. */
  workspace_id: number;
  /** Bearer token for `/api:meta` routes. */
  meta_api_token: string;
}

/** The credential stored in `auth.json`, discriminated by `type`. */
export type CredentialRecord = OAuthCredential | TokenCredential;

/** Default project-local cache path. Resolved against the current directory. */
const DEFAULT_AUTH_FILE = join(".xano", "auth.json");

/**
 * Shared cross-project cache path (the default): `~/.sidestep/auth.json`.
 * `$XANO_GLOBAL_CONFIG` overrides the location (mainly for tests, mirroring the
 * client store's `$XANO_CLIENT_FILE`).
 */
export function globalAuthFilePath(): string {
  return process.env.XANO_GLOBAL_CONFIG ?? join(homedir(), ".sidestep", "auth.json");
}

/** The project-local token cache path (`./.xano/auth.json`), resolved absolute. */
export function localAuthFilePath(): string {
  return resolve(DEFAULT_AUTH_FILE);
}

/**
 * Resolve the token cache path. Precedence, highest first:
 *   1. `--config <path>` / `$XANO_CONFIG` — an explicit path always wins.
 *   2. `--local` — the project-local `./.xano/auth.json` cache.
 *   3. the shared `~/.sidestep/auth.json` global cache (the default).
 *
 * `mode` disambiguates the default (step 3):
 *   • `"write"` (login, logout) always targets the shared global cache — the
 *     common flow is one global sign-in reused from every project. Reach the
 *     project-local cache with an explicit `--local` (step 2).
 *   • `"read"` (read-only commands: deploy, sandbox/profile reads, token
 *     refresh) still prefers an existing project-local cache and, when it is
 *     absent, falls back to the global one — so a project that ran
 *     `login --local` keeps working without repeating the flag.
 */
export function resolveAuthFilePath(args: ParsedArgs, mode: "read" | "write" = "read"): string {
  const explicit = args.authFile ?? process.env.XANO_CONFIG;
  if (explicit !== undefined) return resolve(explicit);

  const local = localAuthFilePath();
  if (args.local) return local;

  const global = globalAuthFilePath();
  if (mode === "write") return global;

  // Read: prefer an existing project-local cache, then fall back to the global one.
  if (existsSync(local)) return local;
  return global;
}

/**
 * Read the stored credential. Returns `null` — not a throw — when the file is
 * absent, so callers can emit an actionable "run `sidestep login`" message rather
 * than surfacing an opaque ENOENT.
 *
 * Anything present but unrecognized is a hard error naming the fix. A `token`
 * record is hand-authored, so every field is validated here: a typo should fail
 * at the file, not as a 404 deep inside a meta call.
 */
export function readCredential(path: string): CredentialRecord | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Credential file at ${path} is corrupt (invalid JSON). Delete it and run \`sidestep login\` again.`,
    );
  }
  return parseCredential(parsed, path);
}

/**
 * Is this parsed value a sidestep credential file — including a stale one?
 *
 * Used only by the write/delete guards, which answer "is this file OURS", not
 * "is this file valid". A pre-typed record (no `type`, but the old
 * `access_token` + `instance` shape) is ours: `login` must be able to overwrite
 * it and `logout` to delete it, or the format break would strand users needing a
 * manual `rm`. Reading it still fails loudly — see `parseCredential`.
 */
function isCredentialRecord(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const record = v as Record<string, unknown>;
  if (record.type === "oauth" || record.type === "token") return true;
  // Legacy (pre-`type`) OAuth cache.
  return typeof record.access_token === "string" && typeof record.instance === "string";
}

/** Validate a parsed value into a credential, or throw naming the exact problem. */
function parseCredential(v: unknown, path: string): CredentialRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`Credential file at ${path} is not a JSON object. ${REAUTH_HINT}`);
  }
  const record = v as Record<string, unknown>;
  const type = record.type;

  if (type === undefined) {
    throw new Error(
      `Credential file at ${path} has no \`type\` field — it predates the typed credential ` +
        `format. Run \`sidestep login\` again to replace it.`,
    );
  }
  if (type === "oauth") return parseOAuth(record, path);
  if (type === "token") return parseToken(record, path);
  throw new Error(
    `Credential file at ${path} has an unrecognized \`type\` (${JSON.stringify(type)}). ` +
      `Expected "oauth" or "token".`,
  );
}

const REAUTH_HINT = "Delete it and run `sidestep login` again.";

function parseOAuth(record: Record<string, unknown>, path: string): OAuthCredential {
  const at = `in the "oauth" credential at ${path}`;
  if (typeof record.access_token !== "string" || record.access_token === "") {
    throw new Error(`Missing \`access_token\` ${at}. ${REAUTH_HINT}`);
  }
  if (typeof record.instance !== "string" || record.instance === "") {
    throw new Error(`Missing \`instance\` ${at}. ${REAUTH_HINT}`);
  }
  if (record.workspace_id === undefined) {
    throw new Error(
      `Missing \`workspace_id\` ${at} — it predates workspace pinning at login. ${REAUTH_HINT}`,
    );
  }
  return {
    type: "oauth",
    access_token: record.access_token,
    refresh_token: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    expires_at: typeof record.expires_at === "number" ? record.expires_at : 0,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    instance: record.instance,
    workspace_id: requireWorkspaceId(record.workspace_id, at),
    auth_host: typeof record.auth_host === "string" ? record.auth_host : "",
    client_id: typeof record.client_id === "string" ? record.client_id : "",
  };
}

function parseToken(record: Record<string, unknown>, path: string): TokenCredential {
  const at = `in the "token" credential at ${path}`;
  const raw = record.instance_base_url;
  if (typeof raw !== "string" || raw === "") {
    throw new Error(
      `Missing \`instance_base_url\` ${at}. It must be the instance URL, ` +
        `e.g. "https://your-instance.xano.io".`,
    );
  }
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    throw new Error(
      `\`instance_base_url\` ${at} is not a valid URL ("${raw}"), ` +
        `e.g. "https://your-instance.xano.io".`,
    );
  }
  const token = record.meta_api_token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`Missing \`meta_api_token\` ${at}. It must be a meta API bearer token.`);
  }
  if (record.workspace_id === undefined) {
    throw new Error(`Missing \`workspace_id\` ${at}. It must be the numeric workspace id.`);
  }
  return {
    type: "token",
    instance_base_url: origin,
    workspace_id: requireWorkspaceId(record.workspace_id, at),
    // A pasted token routinely carries stray whitespace or a newline.
    meta_api_token: token.trim(),
  };
}

/** A workspace id is a positive integer — never a numeric string, zero, or a float. */
function requireWorkspaceId(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `\`workspace_id\` ${at} must be a positive integer (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/**
 * Atomically write the credentials with owner-only permissions. Content is
 * staged in a per-pid temp file (created mode 0600) and renamed into place, so
 * a crash never leaves a half-written or world-readable credential file.
 */
export function writeCredential(path: string, credential: CredentialRecord): void {
  // Guard against an `--config` typo clobbering an unrelated file (e.g.
  // package.json): if the target already exists, it must already be a sidestep
  // credential before we overwrite it.
  assertOursIfPresent(path, "overwrite");
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(credential, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Refuse to touch a file that exists but isn't one of ours, so a `--config`
 * typo can't clobber or `rm` an unrelated file. Deliberately checks only the
 * discriminator: a credential that fails full validation is still OURS, and
 * must stay overwritable (by `login`) and deletable (by `logout`) — otherwise a
 * stale pre-typed record would be unrecoverable without a manual `rm`.
 */
function assertOursIfPresent(path: string, verb: "overwrite" | "delete"): void {
  if (!existsSync(path)) return;
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Unparseable: we can't prove it's ours, so treat it as someone else's.
    existing = undefined;
  }
  if (!isCredentialRecord(existing)) {
    throw new Error(
      `Refusing to ${verb} ${path}: it exists but is not a sidestep credential file. ` +
        `Choose a different --config/$XANO_CONFIG path.`,
    );
  }
}

/**
 * Delete the credential file (logout). Returns true when a file was removed,
 * false when there was nothing to remove. Refuses to delete a file that isn't a
 * sidestep credential, so a `--config` typo can't `rm` an unrelated file.
 */
export function clearCredential(path: string): boolean {
  if (!existsSync(path)) return false;
  assertOursIfPresent(path, "delete");
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
