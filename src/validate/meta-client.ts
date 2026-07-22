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
import { decodeWorkspaceArchive } from "./archive.js";
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

/** Outcome of running a function: its status plus the parsed (or raw) body. */
export interface InvokeResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body when the response was JSON, else the raw text. */
  body: unknown;
}

/**
 * A client bound to one instance + token. Read methods (`getFunction`,
 * `listFunctions`) throw on a non-2xx with the endpoint's body attached;
 * {@link runFunction} returns the status so callers can inspect error responses.
 */
export class MetaClient {
  /**
   * Origin that post-import reads/runs target. The import goes to the root
   * instance's `sandbox/bundle`, but the objects land in a sandbox TENANT served
   * under a `/tenant/<slug>` path (the import response's `base_url`). Reads must
   * hit that tenant-scoped origin, not the root — so this is switched to
   * `base_url` after a successful import (falls back to the root instance).
   */
  private readBase: string;

  constructor(private readonly config: ValidateConfig) {
    this.readBase = config.instance;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}` };
  }

  /**
   * Build a read/run URL against {@link readBase}, APPENDING the route so any
   * `/tenant/<slug>` path prefix survives (a leading-slash `new URL(path, base)`
   * would drop it back to the origin).
   */
  private readUrl(path: string): URL {
    return new URL(`${this.readBase}${path}`);
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
    // Point subsequent reads/runs at the tenant the import landed in.
    if (resp.baseUrl !== undefined && resp.baseUrl !== "") {
      this.readBase = resp.baseUrl.replace(/\/+$/, "");
    }
    return { workspaceId, baseUrl: resp.baseUrl, raw: resp.raw };
  }

  /**
   * Export the workspace (the sandbox tenant, post-import) as a `packageExport`
   * bundle — the SAME shape the SDK emits, carrying full object logic. This is
   * the faithful round-trip source: the response is a gzipped tar of
   * `workspace.json`, decoded here into its bundle object.
   */
  async exportWorkspace(workspaceId: number): Promise<{ payload: Record<string, unknown> }> {
    const url = this.readUrl(`/api:meta/workspace/${workspaceId}/export`);
    const res = await fetch(url.href, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "", password: "" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Export of workspace ${workspaceId} failed (${res.status} ${res.statusText}):\n${text}`);
    }
    const decoded = decodeWorkspaceArchive(new Uint8Array(await res.arrayBuffer())) as {
      payload?: Record<string, unknown>;
    };
    return { payload: decoded.payload ?? {} };
  }

  /**
   * Run a named workspace function via the meta function-run route. Unlike the
   * read methods this returns the status (rather than throwing) so a caller can
   * report an engine error + logs as a runtime outcome.
   */
  async runFunction(workspaceId: number, name: string, input?: unknown): Promise<InvokeResult> {
    const url = this.readUrl(`/api:meta/workspace/${workspaceId}/function/run`);
    const res = await fetch(url.href, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name, input: input ?? {} }),
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
