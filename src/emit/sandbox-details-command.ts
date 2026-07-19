/**
 * `sidestep sandbox details` — print the caller's singleton sandbox tenant, with
 * its public **base URL** as the headline field, as JSON on stdout. An agent
 * reads the base URL to point a frontend (or an HTTP client) at the backend it
 * deployed with `sidestep sandbox deploy`, without having to re-run a deploy to
 * recover it from the deploy response.
 *
 * Reuses the existing `GET /api:meta/sandbox/me` endpoint ("get or create the
 * singleton sandbox tenant"). It **projects only** the safe, stable fields —
 * id/name/display/state/domain/expiry — never the raw tenant blob, which carries
 * cluster/k8s/license internals that would land in shell history and CI logs.
 *
 * The base URL is derived from the tenant exactly as the backend does
 * (`Run::getBaseUrl` in cloud-client): `https://{xano_domain}` when the tenant
 * has its own domain, else the instance origin with a `/tenant/{name}` prefix
 * (the self-hosted / local fallback). `localhost:*` hosts stay `http`.
 *
 * Node-only and lazily imported (like `profile me`/`login`) so the browser-safe
 * authoring bundle never pulls in the OAuth stack.
 */
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";

/** Bound the metadata fetch so a stalled endpoint can't hang the CLI. */
const SANDBOX_TIMEOUT_MS = 30_000;

/** The projected, safe-to-print sandbox details. Never carries the raw tenant blob. */
export interface SandboxDetails {
  /** Public base URL of the sandbox — the headline field. */
  baseUrl: string;
  sandbox: {
    id: number | undefined;
    name: string | undefined;
    display: string | undefined;
    state: string | undefined;
    /** The tenant's own domain host (e.g. `abc123.xano.io`), if it has one. */
    xanoDomain: string | undefined;
    /** ISO/epoch expiry of the current sandbox session, if the endpoint reports one. */
    expiresAt: string | number | undefined;
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Derive the sandbox's public base URL from its tenant record, mirroring the
 * backend's `Run::getBaseUrl`: prefer the tenant's own `xano_domain`, else fall
 * back to the instance origin with a `/tenant/{name}` prefix. Never throws — a
 * tenant with neither field yields the bare instance origin.
 */
export function sandboxBaseUrl(tenant: Record<string, unknown>, instance: string): string {
  const host = asString(tenant.xano_domain);
  if (host !== undefined) {
    const scheme = host.startsWith("localhost:") ? "http" : "https";
    return `${scheme}://${host}`;
  }
  const name = asString(tenant.name);
  if (name !== undefined) {
    return new URL(`/tenant/${name}`, instance).href.replace(/\/$/, "");
  }
  return instance.replace(/\/$/, "");
}

/**
 * Fetch and project the caller's sandbox tenant. The base URL is derived from
 * the tenant record (see `sandboxBaseUrl`); the raw blob is deliberately dropped.
 */
export async function fetchSandboxDetails(args: ParsedArgs): Promise<SandboxDetails> {
  const { access_token, instance } = await getAccessToken(args);
  const url = new URL("/api:meta/sandbox/me", instance);
  const res = await fetch(url.href, {
    headers: { accept: "application/json", Authorization: `Bearer ${access_token}` },
    signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`sandbox details failed (${res.status} ${res.statusText}):\n${text}`);
  }
  let tenant: Record<string, unknown> = {};
  try {
    tenant = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`sandbox details: could not parse the ${url.pathname} response as JSON:\n${text}`);
  }
  const expiresAt = tenant.sandbox_expires_at;
  return {
    baseUrl: sandboxBaseUrl(tenant, instance),
    sandbox: {
      id: typeof tenant.id === "number" ? tenant.id : undefined,
      name: asString(tenant.name),
      display: asString(tenant.display),
      state: asString(tenant.state),
      xanoDomain: asString(tenant.xano_domain),
      expiresAt: typeof expiresAt === "string" || typeof expiresAt === "number" ? expiresAt : undefined,
    },
  };
}

export async function runSandboxDetailsCommand(args: ParsedArgs): Promise<void> {
  const details = await fetchSandboxDetails(args);
  process.stdout.write(JSON.stringify(details, null, 2) + "\n");
}
