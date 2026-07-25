import { encodeWorkspaceArchive } from "../../src/validate/archive.js";

/**
 * Build a gzipped ustar archive containing a single `workspace.json` — the shape
 * the workspace-export endpoint returns — so tests can exercise the decode +
 * round-trip paths without a live instance. Delegates to the production encoder
 * so this fixture can never drift from what deploy actually uploads.
 */
export function buildWorkspaceArchive(bundle: unknown): Uint8Array {
  return encodeWorkspaceArchive(JSON.stringify(bundle));
}
