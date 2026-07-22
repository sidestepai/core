/**
 * Config + token resolution for `sidestep validate`.
 *
 * This is engineer tooling, not a consumer product: the target instance is a
 * plain base-URL + bearer token, read from the environment (a cwd `.env` is
 * autoloaded when present). No OAuth, no login handshake — the engineer supplies
 * a token they already have. Switching a cloud instance ↔ local Docker is just a
 * different `XANO_VALIDATE_INSTANCE`.
 *
 * Node-only (reads process.env / the filesystem); lazily imported by the command
 * layer so the browser-safe authoring bundle never pulls it in.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

/** Bound the whoami check so a stalled endpoint can't hang the CLI. */
const AUTH_CHECK_TIMEOUT_MS = 30_000;

/** Environment variable names the config reads (documented in `.env.example`). */
const ENV_INSTANCE = "XANO_VALIDATE_INSTANCE";
const ENV_TOKEN = "XANO_VALIDATE_TOKEN";
const ENV_WORKSPACE = "XANO_VALIDATE_WORKSPACE_ID";

/** A resolved validation target: which instance, which token, optional workspace. */
export interface ValidateConfig {
  /** Instance origin the meta API is served from (e.g. `https://x.xano.io` or `http://localhost:8080`). */
  instance: string;
  /** Meta bearer token. */
  token: string;
  /** Optional workspace id override; when omitted the import response supplies it. */
  workspaceId: number | undefined;
}

/** CLI overrides that win over the environment (never a token — that stays env-only). */
export interface ValidateOverrides {
  instance?: string;
  workspaceId?: number;
}

/**
 * Load a cwd `.env` into `process.env` WITHOUT clobbering already-set vars, so a
 * real environment variable always wins over the file. Deliberately a tiny
 * KEY=VALUE parser (no dependency, predictable precedence) rather than Node's
 * built-in `loadEnvFile`, whose override semantics differ across versions.
 */
function loadDotEnv(): void {
  const path = resolvePath(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/** Parse + validate the instance into a bare origin, or throw with an actionable message. */
function resolveOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${ENV_INSTANCE} must be a full URL (got "${raw}"), e.g. https://your-instance.xano.io or http://localhost:8080.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${ENV_INSTANCE} must be an http(s) URL (got protocol "${url.protocol}").`);
  }
  return url.origin;
}

/**
 * Resolve `{ instance, token, workspaceId }` from CLI overrides + env (+ `.env`).
 * Throws a clear, variable-naming error when a required value is missing.
 */
export function resolveValidateConfig(overrides: ValidateOverrides = {}): ValidateConfig {
  loadDotEnv();

  const rawInstance = overrides.instance ?? process.env[ENV_INSTANCE];
  if (rawInstance === undefined || rawInstance === "") {
    throw new Error(`Missing target instance. Set ${ENV_INSTANCE} (a base URL) or pass --instance <url>.`);
  }
  const instance = resolveOrigin(rawInstance);

  const token = process.env[ENV_TOKEN];
  if (token === undefined || token === "") {
    throw new Error(`Missing token. Set ${ENV_TOKEN} in your environment or a .env file (kept out of git).`);
  }

  // A CLI override is already validated at the boundary (`parseWorkspaceId`), so
  // trust it — the same way the `instance` override is trusted. Only the raw
  // env-string path needs parsing + validation here.
  let workspaceId = overrides.workspaceId;
  if (workspaceId === undefined) {
    const raw = process.env[ENV_WORKSPACE];
    if (raw !== undefined && raw !== "") {
      workspaceId = Number(raw);
      if (!Number.isInteger(workspaceId) || workspaceId < 1) {
        throw new Error(`${ENV_WORKSPACE} must be a positive integer (got "${raw}").`);
      }
    }
  }

  return { instance, token, workspaceId };
}

/** The projected, secret-free slice of `GET /api:meta/auth/me` the command surfaces. */
export interface WhoAmI {
  /** Best-effort account label, when the endpoint returns one. */
  name: string | undefined;
}

/**
 * Verify the token against the instance via `GET /api:meta/auth/me`. Throws on a
 * non-2xx (the whole point of the early check: fail before importing anything).
 */
export async function verifyToken(config: ValidateConfig): Promise<WhoAmI> {
  const url = new URL("/api:meta/auth/me", config.instance);
  const res = await fetch(url.href, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token check failed (${res.status} ${res.statusText}) against ${url.host}. ` +
        `Is ${ENV_TOKEN} valid for this instance?\n${text}`,
    );
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON but 2xx — treat as a valid, unlabeled session */
  }
  const name = typeof data.name === "string" ? data.name : undefined;
  return { name };
}
