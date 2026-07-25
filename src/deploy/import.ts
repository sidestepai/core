/**
 * Node-only transport that imports a compiled workspace into an ephemeral or
 * sandbox environment. The env is its own Xano environment at its own base URL,
 * and the caller's SAME OAuth token authenticates against it, so deploy is:
 * create/resolve the env → `POST {base_url}/api:meta/workspace/1/import`.
 *
 * The env's internal workspace id is always `1`, and importing WITH a workspace
 * id takes the server's restore path (clear-then-import) — a full replace, which
 * is exactly the reset-by-default semantics we want. The payload is the
 * `gzip(tar(workspace.json))` archive from {@link encodeWorkspaceArchive},
 * uploaded as the multipart `file` field.
 *
 * The URL is built by string concatenation (not `new URL(absolutePath, base)`)
 * so a self-hosted base URL that carries a `/tenant/{name}` path prefix is
 * preserved rather than discarded.
 */
import type { ResolvedAuth } from "../auth/token.js";

/** Match the deploy upload bound in `client.ts` so a stalled import can't hang CI. */
const IMPORT_TIMEOUT_MS = 120_000;

export interface ImportResult {
  /** The env-internal workspace id the import reports back (always 1 in practice). */
  workspaceId: number | undefined;
  /** Raw response body, kept for diagnostics. */
  raw: string;
}

/**
 * Multipart-POST the workspace archive to an env's `workspace/1/import`. The
 * filename must NOT end in `.enc.gz` (the server treats that as encrypted); a
 * plain `.gz` name imports unencrypted with no password.
 */
export async function importWorkspaceArchive(
  auth: ResolvedAuth,
  opts: { baseUrl: string; archive: Uint8Array },
): Promise<ImportResult> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api:meta/workspace/1/import`;

  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed Blob so the multipart body is exact.
  form.append("file", new Blob([opts.archive], { type: "application/gzip" }), "workspace.gz");

  // No manual Content-Type — fetch sets the multipart boundary for us.
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
    body: form,
    signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`import failed (${res.status} ${res.statusText}):\n${text}`);
  }

  let workspaceId: number | undefined;
  try {
    const parsed = JSON.parse(text) as { id?: unknown };
    if (typeof parsed.id === "number") workspaceId = parsed.id;
  } catch {
    /* non-JSON success body — fine; id stays undefined */
  }
  return { workspaceId, raw: text };
}
