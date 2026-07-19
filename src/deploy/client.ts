/**
 * Node-only deploy transport: gzip a compiled workspace bundle and POST it to a
 * deploy endpoint (real-workspace `/api:meta/workspace/deploy` or the sandbox
 * `/api:meta/sandbox/bundle`), authenticating with an OAuth access token.
 *
 * Compression (KTD-5): the body is gzipped and the endpoint gunzips it by magic-byte
 * detection. We deliberately do NOT send `Content-Encoding: gzip` — an intermediary
 * that honored it would inflate the body before the app, delivering raw JSON and
 * silently bypassing the endpoint's bounded streaming-inflate guard. The bundle is
 * still `Content-Type: application/json` (its decompressed content is JSON).
 *
 * Node-only (`node:zlib`) and lazily imported by the command layer, so the browser-safe
 * authoring bundle never pulls it in.
 */
import { gzipSync } from "node:zlib";
import type { ResolvedAuth } from "../auth/token.js";

/** Bound the upload so a stalled endpoint can't hang the CLI/CI forever. */
const UPLOAD_TIMEOUT_MS = 120_000;

export interface DeployRequest {
  /** The compiled workspace bundle JSON (text). */
  bundle: string;
  /** Meta-API route, e.g. `/api:meta/workspace/deploy` or `/api:meta/sandbox/bundle`. */
  endpointPath: string;
  /** Access token + the instance origin it authorizes against. */
  auth: ResolvedAuth;
  /** `--reset`: full clear then import (`?reset=true`). */
  reset?: boolean;
  /** `--prune`: remove server objects absent from the bundle (`?prune=true`). */
  prune?: boolean;
}

export interface DeployResponse {
  /** The workspace's public base URL (endpoints return `base_url`; older ones `url`). */
  baseUrl: string | undefined;
  /** The imported workspace object; carries the numeric `id` the static-host path needs. */
  workspace: { id?: number; name?: string; [k: string]: unknown } | undefined;
  /** The server's authoritative post-import lock (a `LockFile`-shaped value), if returned. */
  lock: unknown;
  /** Public-URL tokens the import regenerated, if the endpoint reports them. */
  canonicalChanges: unknown;
  /** The raw response body — streamed to stdout unchanged. */
  raw: string;
}

/**
 * POST a gzipped bundle to a deploy endpoint and parse the response. Throws on a
 * non-2xx status with the endpoint's body attached. Tolerates a response that
 * omits `lock` (an older endpoint) — `lock` is simply `undefined` then.
 */
export async function postDeploy(req: DeployRequest): Promise<DeployResponse> {
  const url = new URL(req.endpointPath, req.auth.instance);
  if (req.reset) url.searchParams.set("reset", "true");
  if (req.prune) url.searchParams.set("prune", "true");

  const body = gzipSync(Buffer.from(req.bundle, "utf8"));

  const res = await fetch(url.href, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.auth.access_token}`,
    },
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Deploy to ${url.pathname} failed (${res.status} ${res.statusText}):\n${text}`);
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON response — surface it verbatim, fields stay undefined */
  }
  const baseUrl =
    typeof parsed.base_url === "string" ? parsed.base_url : typeof parsed.url === "string" ? parsed.url : undefined;
  return {
    baseUrl,
    workspace: (parsed.workspace as DeployResponse["workspace"]) ?? undefined,
    lock: parsed.lock,
    canonicalChanges: parsed.canonical_changes,
    raw: text,
  };
}
