/**
 * The one call that reads a workspace back out of Xano:
 * `POST {base}/api:meta/workspace/{id}/export` → a gzipped archive → the bundle.
 *
 * Every environment SideStep can read uses it, differing only in which origin and
 * which workspace id they point at:
 *
 * - **workspace** — the caller's real workspace on the instance the OAuth token
 *   is bound to, at the id that token is scoped to.
 * - **sandbox** — the singleton sandbox tenant's own origin, at the one workspace
 *   the tenant has.
 * - **ephemeral** — the environment's base URL, where the workspace id is always 1.
 *
 * Extracted here because the three had drifted into three near-identical copies,
 * and because `codegen` needs the parsed bundle rather than the JSON text the
 * `export` commands write.
 *
 * All three read **configuration, not table rows** — see the note on
 * {@link exportWorkspaceBundle} for why requesting rows would only ever produce
 * the same bundle, more slowly.
 *
 * Node-only (fetch); lazily imported by the command layer so the browser-safe
 * authoring bundle never pulls it in.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";

/** A workspace archive can be large; bound the call the way the sandbox export does. */
const EXPORT_TIMEOUT_MS = 120_000;

/** A decoded `packageExport` bundle, as the decode layer consumes it. */
export interface ExportedBundle {
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Export one workspace as its bundle.
 *
 * `base` is an origin (optionally with a path prefix, as a tenant-scoped meta
 * origin has), so routes are APPENDED rather than resolved against it — a `new
 * URL(path, base)` would silently drop a `/tenant/<name>` prefix.
 *
 * `label` names the caller in errors, since the same failure means different
 * things per environment ("run `sidestep deploy` first" vs "your token is scoped
 * elsewhere").
 *
 * **Table rows are never requested.** Nothing on the read side can consume them:
 * `decodeWorkspaceArchive` takes `workspace.json` and discards the archive's
 * `content/` entries, so every row the server sent was fetched, held, and
 * dropped. Asking for them is pure cost, and an unbounded one — the server pages
 * through every row of every table and buffers the archive before emitting a
 * byte, so a workspace holding real data outlasts any client-side bound.
 *
 * This is the read half of an asymmetry, not a limitation of the format: the
 * write half ships seed rows as `content/<guid>-<page>.json` entries (see
 * `workspace/seed.ts`). When a decoder for those lands, `records` becomes a
 * caller's choice again — until something can read a row, requesting one would
 * be a slower way to produce the same bundle.
 *
 * `records` is a hint, not a contract: an instance predating the field ignores
 * it and returns the full archive, which decodes to the same bundle regardless.
 */
export async function exportWorkspaceBundle(
  auth: ResolvedAuth,
  opts: { base: string; workspaceId: number; label: string },
): Promise<ExportedBundle> {
  const base = opts.base.replace(/\/$/, "");
  const res = await fetch(`${base}/api:meta/workspace/${opts.workspaceId}/export`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
    // `branch`/`password` are required; the defaults mean "current branch, no
    // archive password". `records: false` skips table content — see above.
    body: JSON.stringify({ branch: "", password: "", records: false }),
    signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `${opts.label} failed (${res.status} ${res.statusText}):\n${describeErrorBody(
        new Uint8Array(await res.arrayBuffer()),
        res.headers.get("content-type"),
      )}`,
    );
  }
  const bundle = decodeWorkspaceArchive(new Uint8Array(await res.arrayBuffer()));
  if (bundle === null || typeof bundle !== "object" || !("payload" in bundle)) {
    throw new Error(`${opts.label}: the exported archive carried no \`payload\` — not a workspace bundle.`);
  }
  return bundle as ExportedBundle;
}

/**
 * Render a failed export's body for a terminal.
 *
 * This route answers with an ARCHIVE, and at least one instance has been seen
 * returning `500` with a complete `.tar.gz` in the body. Piping those bytes
 * straight to stderr — which the plain `res.text()` this replaces did — floods
 * the terminal with mojibake and can abort whatever is downstream of the pipe.
 * So: text bodies print as text (the useful case — a JSON or plain-text error),
 * and anything binary is described instead of dumped.
 */
function describeErrorBody(bytes: Uint8Array, contentType: string | null): string {
  const type = contentType ? ` (content-type: ${contentType})` : "";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // A replacement char or a C0 control (tab/newline/CR excepted) means these
  // bytes were never text to begin with.
  // eslint-disable-next-line no-control-regex
  const NOT_TEXT = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
  if (bytes.length > 0 && !NOT_TEXT.test(text)) {
    return text.length > 2000 ? `${text.slice(0, 2000)}\n… (${text.length} chars, truncated)` : text;
  }
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (
    `<${bytes.length} bytes of ${gzip ? "gzip data" : "binary"}, not text${type}>` +
    (gzip
      ? ` — the body looks like a workspace archive, so the instance answered with a payload AND an error status. ` +
        `The status is what SideStep goes by; re-run the export, and if it persists the instance is failing mid-export.`
      : "")
  );
}
