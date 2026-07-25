/**
 * Decode a Xano workspace export archive into its `workspace.json` bundle.
 *
 * The export endpoint serves a gzipped tar (observed double-gzipped) whose root
 * holds `workspace.json` — the same `packageExport` shape the SDK emits, with
 * full object logic (`run`/`result`). This is what makes a faithful round-trip
 * (and real fixture capture) possible: both sides are packageExport, so the
 * existing normalizer compares them directly.
 *
 * Node-only (uses `node:zlib`); reached through the meta client.
 */
import { gunzipSync } from "node:zlib";
import { tarGz } from "../util/tar.js";

/** One archive member: its in-archive path and the UTF-8 text stored at it. */
export interface ArchiveEntry {
  name: string;
  content: string;
}

/**
 * Encode a compiled `packageExport` bundle into the `gzip(tar(...))` archive the
 * workspace-import endpoint (`POST /api:meta/workspace/{id}/import`) accepts — the
 * exact inverse of {@link decodeWorkspaceArchive}. The bundle text is written
 * verbatim as the root `workspace.json` entry (the path the server reads back from
 * its extraction dir); any `extra` members (e.g. `content/<guid>-<page>.json` seed
 * files) follow it in order, so the deploy path reuses the SDK's existing bundle
 * plus its seed content unchanged.
 *
 * The result is a single-gzip archive; the server peels every gzip layer, so one
 * is enough. Callers upload it as the multipart `file` field with a filename
 * that must NOT end in `.enc.gz` (which the server treats as encrypted).
 */
export function encodeWorkspaceArchive(
  workspaceJson: string,
  extra: readonly ArchiveEntry[] = [],
): Uint8Array {
  return tarGz([
    { name: "workspace.json", data: Buffer.from(workspaceJson, "utf8") },
    ...extra.map((e) => ({ name: e.name, data: Buffer.from(e.content, "utf8") })),
  ]);
}

/** Peel gzip layers, untar, and return the parsed `workspace.json` object. */
export function decodeWorkspaceArchive(data: Uint8Array): unknown {
  let buf = Buffer.from(data);
  // The export is gzipped (sometimes twice); peel every gzip layer.
  let guard = 0;
  while (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && guard++ < 8) {
    buf = gunzipSync(buf);
  }
  const files = readTar(buf);
  const key = Object.keys(files).find((k) => k.endsWith("workspace.json"));
  if (key === undefined) {
    const seen = Object.keys(files).join(", ") || "none";
    throw new Error(`Workspace export archive has no workspace.json (entries: ${seen}).`);
  }
  return JSON.parse(files[key]!.toString("utf8")) as unknown;
}

/**
 * Minimal ustar reader → `{ filename: contents }`. Each entry is a 512-byte
 * header (name@0..100, octal size@124..136) followed by its data padded to a
 * 512-byte boundary. Sufficient for the small, GNU-tar-produced workspace archive.
 */
function readTar(buf: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (name === "") break; // two zero blocks mark the archive end
    const sizeField = buf.toString("utf8", off + 124, off + 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField || "0", 8);
    const start = off + 512;
    if (Number.isFinite(size) && size > 0) files[name] = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}
