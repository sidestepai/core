/**
 * Node-only transport for ephemeral-tenant lifecycle on the parent meta-API:
 * create / get / list / delete, plus a readiness poll. Everything is projected
 * to a small, secret-free {@link EphemeralSummary} — the raw tenant blob carries
 * cluster/k8s/license internals that must never land in shell history or CI logs.
 *
 * Two workspace ids are in play and must not be confused: the PARENT workspace id
 * (resolved from the caller's token) scopes these routes and is where an
 * ephemeral is *created*; the env's own internal workspace id is always `1` and
 * is only used later, by the import transport, against the env's base URL.
 *
 * Follows the SDK's fetch conventions: `new URL(path, auth.instance)`, a bearer
 * header, an `AbortSignal.timeout` bound, and a
 * `"<action> failed (<status> <statusText>):\n<body>"` error on non-2xx.
 */
import type { ResolvedAuth } from "../auth/token.js";

/** Bound each metadata call so a stalled endpoint can't hang the CLI/CI. */
const TIMEOUT_MS = 30_000;
/** Readiness poll defaults: a freshly created ephemeral may be provisioning. */
const READY_TIMEOUT_MS = 120_000;
const READY_INTERVAL_MS = 2_000;

/** The projected, safe-to-print view of an ephemeral tenant. Never the raw blob. */
export interface EphemeralSummary {
  id: number | undefined;
  /** Server-assigned tenant name — the stable handle. */
  name: string;
  display: string | undefined;
  /** Public base URL (`https://{xano_domain}`), or undefined if the row omits a domain. */
  url: string | undefined;
  state: string | undefined;
  /** `ephemeral_expires_at` as the API serializes it (date string or epoch number). */
  expiresAt: string | number | undefined;
  /** Parent workspace id, when the row carries one (global list). */
  workspaceId: number | undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Derive a tenant's public base URL, mirroring the backend: prefer its own
 * `xano_domain` (`https://`, or `http://` for `localhost:*`), else the instance
 * origin with a `/tenant/{name}` prefix. Never throws.
 */
export function tenantBaseUrl(tenant: Record<string, unknown>, instance: string): string {
  const host = asString(tenant.xano_domain);
  if (host !== undefined) {
    const scheme = host.startsWith("localhost:") ? "http" : "https";
    return `${scheme}://${host}`;
  }
  const name = asString(tenant.name);
  if (name !== undefined) return new URL(`/tenant/${name}`, instance).href.replace(/\/$/, "");
  return instance.replace(/\/$/, "");
}

/** Parse an `ephemeral_expires_at` (date string or epoch seconds) to epoch ms, or NaN. */
export function expiresAtMs(expiresAt: string | number | undefined): number {
  if (expiresAt === undefined || expiresAt === null) return NaN;
  return typeof expiresAt === "number" ? expiresAt * 1000 : Date.parse(String(expiresAt).replace(" ", "T"));
}

/** True when the tenant's expiry is known and already in the past. */
export function isExpired(expiresAt: string | number | undefined): boolean {
  const ms = expiresAtMs(expiresAt);
  return Number.isFinite(ms) && ms <= Date.now();
}

/**
 * Project a raw tenant record to the safe summary, deriving its base URL. The URL
 * always resolves: the tenant's own `xano_domain` when it has one, else the
 * instance-origin tenant path (`{instance}/tenant/{name}`) — the form dev/self-
 * hosted instances use when a tenant has no dedicated domain. `url` is undefined
 * only when the row carries no name to route to.
 */
function project(tenant: Record<string, unknown>, instance: string): EphemeralSummary {
  const name = asString(tenant.name);
  return {
    id: asNumber(tenant.id),
    name: name ?? "",
    display: asString(tenant.display),
    url: name !== undefined || asString(tenant.xano_domain) ? tenantBaseUrl(tenant, instance) : undefined,
    state: asString(tenant.state),
    expiresAt: (tenant.ephemeral_expires_at as string | number | undefined) ?? undefined,
    workspaceId: asNumber(tenant.workspace_id),
  };
}

async function metaFetch(auth: ResolvedAuth, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, auth.instance);
  return fetch(url.href, {
    ...init,
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${auth.access_token}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function readJson(res: Response, action: string, pathname: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${action} failed (${res.status} ${res.statusText}):\n${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${action}: could not parse the ${pathname} response as JSON:\n${text}`);
  }
}

/** Create a new ephemeral tenant in the parent workspace. */
export async function createEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; display: string; description?: string; expiresHours?: number },
): Promise<EphemeralSummary> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/ephemeral`;
  const body: Record<string, unknown> = { display: opts.display, tag: [] };
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.expiresHours !== undefined) body.expires_hours = opts.expiresHours;
  const res = await metaFetch(auth, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const tenant = (await readJson(res, "create ephemeral", path)) as Record<string, unknown>;
  return project(tenant, auth.instance);
}

/** Get an ephemeral tenant by name. Returns `null` on 404 (swept/deleted) so callers can create. */
export async function getEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string },
): Promise<EphemeralSummary | null> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/tenant/${opts.name}`;
  const res = await metaFetch(auth, path, { method: "GET" });
  if (res.status === 404) {
    await res.text().catch(() => "");
    return null;
  }
  const tenant = (await readJson(res, "get ephemeral", path)) as Record<string, unknown>;
  return project(tenant, auth.instance);
}

/** List ephemeral tenants in a workspace. Tolerates both a bare array and a `{ items }` envelope. */
export async function listEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number },
): Promise<EphemeralSummary[]> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/ephemeral`;
  const data = await readJson(await metaFetch(auth, path, { method: "GET" }), "list ephemerals", path);
  return toRows(data).map((t) => project(t, auth.instance));
}

/** List ephemeral tenants across every workspace the caller can access. */
export async function listAllEphemeral(auth: ResolvedAuth): Promise<EphemeralSummary[]> {
  const path = `/api:meta/ephemeral`;
  const data = await readJson(await metaFetch(auth, path, { method: "GET" }), "list ephemerals", path);
  return toRows(data).map((t) => project(t, auth.instance));
}

function toRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: Record<string, unknown>[] }).items;
  }
  return [];
}

/** Delete an ephemeral tenant. A 404 is treated as already-gone (idempotent), not an error. */
export async function deleteEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string },
): Promise<{ alreadyGone: boolean }> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/tenant/${opts.name}`;
  const res = await metaFetch(auth, path, { method: "DELETE" });
  if (res.status === 404) {
    await res.text().catch(() => "");
    return { alreadyGone: true };
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`delete ephemeral failed (${res.status} ${res.statusText}):\n${text}`);
  return { alreadyGone: false };
}

/**
 * Poll until the ephemeral reports `state === "ok"` (importable), bounded by
 * `timeoutMs`. A freshly created tenant may still be provisioning; importing
 * before it is ready fails. Throws a clear error if it never becomes ready.
 */
export async function waitUntilReady(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string },
  cfg: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<EphemeralSummary> {
  const timeoutMs = cfg.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = cfg.intervalMs ?? READY_INTERVAL_MS;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let last: EphemeralSummary | null = null;
  for (;;) {
    last = await getEphemeral(auth, opts);
    if (last && last.state === "ok") return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Ephemeral "${opts.name}" did not become ready within ${Math.round(timeoutMs / 1000)}s ` +
          `(last state: ${last?.state ?? "gone"}). Try \`sidestep deploy\` again.`,
      );
    }
    await sleep(intervalMs);
  }
}
