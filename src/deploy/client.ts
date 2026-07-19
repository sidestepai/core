/**
 * Node-only deploy transport: POST a compiled workspace bundle to the sandbox
 * deploy endpoint (`/api:meta/sandbox/bundle`), authenticating with an OAuth
 * access token.
 *
 * The bundle is sent as raw `Content-Type: application/json`. (Gzip compression
 * of the body was removed as too complex; the endpoint still magic-byte detects
 * gzip, so an uncompressed body is accepted unchanged.)
 *
 * Lazily imported by the command layer so the browser-safe authoring bundle
 * never pulls this Node-only transport in.
 */
import type { ResolvedAuth } from "../auth/token.js";

/** Bound the upload so a stalled endpoint can't hang the CLI/CI forever. */
const UPLOAD_TIMEOUT_MS = 120_000;

export interface DeployRequest {
  /** The compiled workspace bundle JSON (text). */
  bundle: string;
  /** Meta-API route — `/api:meta/sandbox/bundle`. */
  endpointPath: string;
  /** Access token + the instance origin it authorizes against. */
  auth: ResolvedAuth;
  /**
   * Query params appended to the endpoint URL (the sandbox route takes a
   * `reset=true` bool). The `bundle` itself is the raw request body, never a param.
   */
  query?: Record<string, string>;
}

export interface DeployResponse {
  /** The workspace's public base URL (endpoints return `base_url`; older ones `url`). */
  baseUrl: string | undefined;
  /** The imported workspace object; carries the numeric `id` the static-host path needs. */
  workspace: { id?: number; name?: string; [k: string]: unknown } | undefined;
  /** The raw response body — streamed to stdout unchanged. */
  raw: string;
}

/**
 * POST a bundle to a deploy endpoint and parse the response. Throws on a
 * non-2xx status with the endpoint's body attached. Tolerates a response that
 * omits `workspace` — the field is simply `undefined` then.
 */
export async function postDeploy(req: DeployRequest): Promise<DeployResponse> {
  const url = new URL(req.endpointPath, req.auth.instance);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.href, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.auth.access_token}`,
    },
    body: req.bundle,
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
    raw: text,
  };
}
