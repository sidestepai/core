/**
 * JSON-only client for the public Xano meta API, used by `sidestep validate`.
 *
 * Every route here is a public `/api:meta/...` path (plus public `/api:{canonical}`
 * invocation). The client never touches a XanoScript-text route: the SDK emits a
 * JSON bundle, imports it via `sandbox/bundle`, and reads objects back as JSON.
 *
 * The import reuses the proven `postDeploy` transport (the same call
 * `sandbox deploy` makes); the reads/runs are thin fetch wrappers that mirror its
 * bearer + timeout + non-2xx-throws discipline.
 *
 * Node-only; lazily imported by the command layer.
 */
import { postDeploy } from "../deploy/client.js";
import type { ValidateConfig } from "./config.js";

/** Bound each read/run so a stalled endpoint can't hang the CLI. */
const REQUEST_TIMEOUT_MS = 60_000;

const IMPORT_PATH = "/api:meta/sandbox/bundle";

/** Result of importing a compiled bundle into the sandbox tenant. */
export interface ImportResult {
  /** The imported workspace's numeric id — the key for reading objects back. */
  workspaceId: number | undefined;
  /** The workspace's public base URL, when the endpoint returns one. */
  baseUrl: string | undefined;
  /** Raw response body, kept for diagnostics. */
  raw: string;
}

/** A minimal listed API-group: its numeric id and (random) public canonical. */
export interface ApiGroupSummary {
  id: number;
  name: string | undefined;
  canonical: string | undefined;
}

/** Outcome of invoking a deployed endpoint or running a function. */
export interface InvokeResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body when the response was JSON, else the raw text. */
  body: unknown;
}

/**
 * A client bound to one instance + token. All methods speak JSON and throw on a
 * non-2xx with the endpoint's body attached (except {@link invokeApi}/{@link runFunction},
 * which return the status so callers can assert on error responses too).
 */
export class MetaClient {
  constructor(private readonly config: ValidateConfig) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}` };
  }

  /** Import a compiled JSON bundle into the disposable sandbox tenant. */
  async importBundle(bundle: string, opts: { reset?: boolean } = {}): Promise<ImportResult> {
    const query: Record<string, string> = {};
    if (opts.reset) query.reset = "true";
    let resp;
    try {
      resp = await postDeploy({
        bundle,
        endpointPath: IMPORT_PATH,
        auth: { access_token: this.config.token, instance: this.config.instance },
        query,
      });
    } catch (err) {
      // A 404 here means the JSON bundle route is not served on this instance —
      // surface it as an actionable message (validate is JSON-only; there is no
      // XanoScript fallback).
      const msg = err instanceof Error ? err.message : String(err);
      if (/\b404\b/.test(msg)) {
        throw new Error(
          `The JSON import route (${IMPORT_PATH}) is not available on ${new URL(this.config.instance).host}. ` +
            `sidestep validate is JSON-only and cannot fall back to a XanoScript route.\n${msg}`,
        );
      }
      throw err;
    }
    const workspaceId = typeof resp.workspace?.id === "number" ? resp.workspace.id : undefined;
    return { workspaceId, baseUrl: resp.baseUrl, raw: resp.raw };
  }

  /** GET a meta route and parse JSON, throwing on non-2xx. */
  private async getJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.config.instance);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.href, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GET ${url.pathname} failed (${res.status} ${res.statusText}):\n${text}`);
    }
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  }

  /** Read a function back as its persisted JSON object (XanoScript text omitted). */
  getFunction(workspaceId: number, functionId: number): Promise<unknown> {
    return this.getJson(`/api:meta/workspace/${workspaceId}/function/${functionId}`, {
      include_xanoscript: "false",
    });
  }

  /** Read an API endpoint back as its persisted JSON object (XanoScript text omitted). */
  getApi(workspaceId: number, apigroupId: number, apiId: number): Promise<unknown> {
    return this.getJson(`/api:meta/workspace/${workspaceId}/apigroup/${apigroupId}/api/${apiId}`, {
      include_xanoscript: "false",
    });
  }

  /** List the workspace's functions (name → id mapping for round-trip reads). */
  async listFunctions(workspaceId: number): Promise<Array<{ id: number; name: string | undefined }>> {
    const raw = await this.getJson(`/api:meta/workspace/${workspaceId}/function`);
    return asItems(raw).map((o) => ({ id: numberOf(o.id), name: stringOf(o.name) })).filter((f) => Number.isFinite(f.id));
  }

  /** List the workspace's API groups, exposing each group's public `canonical`. */
  async listApigroups(workspaceId: number): Promise<ApiGroupSummary[]> {
    const raw = await this.getJson(`/api:meta/workspace/${workspaceId}/apigroup`);
    return asItems(raw)
      .map((o) => ({ id: numberOf(o.id), name: stringOf(o.name), canonical: stringOf(o.canonical) }))
      .filter((g) => Number.isFinite(g.id));
  }

  /** Run a named workspace function via the meta function-run route; returns status + parsed body. */
  runFunction(workspaceId: number, name: string, input?: unknown): Promise<InvokeResult> {
    return this.postJson(`/api:meta/workspace/${workspaceId}/function/run`, { name, input: input ?? {} });
  }

  /** Invoke a deployed public API at `/api:{canonical}/{path}`; returns status + parsed body. */
  invokeApi(
    canonical: string,
    path: string,
    opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<InvokeResult> {
    const trimmed = path.replace(/^\/+/, "");
    return this.request(`/api:${canonical}/${trimmed}`, opts);
  }

  /** POST JSON to a meta route; returns status + parsed body (does not throw on 4xx/5xx). */
  private postJson(path: string, body: unknown): Promise<InvokeResult> {
    return this.request(path, { method: "POST", body });
  }

  /** Shared request → { status, ok, body } helper for invoke/run paths. */
  private async request(
    path: string,
    opts: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<InvokeResult> {
    const url = new URL(path, this.config.instance);
    const hasBody = opts.body !== undefined;
    const res = await fetch(url.href, {
      method: opts.method ?? (hasBody ? "POST" : "GET"),
      headers: {
        ...this.authHeaders(),
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      /* non-JSON — keep the raw text */
    }
    return { status: res.status, ok: res.ok, body };
  }
}

/** Coerce a list response (bare array or `{ items: [...] }`) to an array of records. */
function asItems(raw: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  return arr.filter((o): o is Record<string, unknown> => o !== null && typeof o === "object");
}

function numberOf(v: unknown): number {
  return typeof v === "number" ? v : NaN;
}
function stringOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
