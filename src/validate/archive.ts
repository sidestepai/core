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
