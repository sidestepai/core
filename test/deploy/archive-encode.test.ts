import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { encodeWorkspaceArchive, decodeWorkspaceArchive } from "../../src/validate/archive.js";

/** Read the first ustar entry's name + parsed size out of an uncompressed tar buffer. */
function firstTarEntry(tar: Buffer): { name: string; size: number; checksumValid: boolean } {
  const name = tar.toString("utf8", 0, 100).replace(/\0.*$/, "");
  const size = parseInt(tar.toString("utf8", 124, 136).replace(/\0.*$/, "").trim() || "0", 8);
  // Recompute the checksum with the checksum field treated as 8 spaces.
  const stored = parseInt(tar.toString("utf8", 148, 156).replace(/\0.*$/, "").trim() || "-1", 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i]!;
  return { name, size, checksumValid: sum === stored };
}

describe("encodeWorkspaceArchive", () => {
  const bundle = {
    app: "xano",
    type: "workspace",
    payload: { function: [{ name: "f", run: [{ name: "mvp:set_var" }] }] },
  };

  it("round-trips through the decoder to the original object", () => {
    const archive = encodeWorkspaceArchive(JSON.stringify(bundle));
    expect(decodeWorkspaceArchive(archive)).toEqual(bundle);
  });

  it("emits a gzip stream", () => {
    const archive = encodeWorkspaceArchive(JSON.stringify(bundle));
    expect(archive[0]).toBe(0x1f);
    expect(archive[1]).toBe(0x8b);
  });

  it("writes exactly one root `workspace.json` entry with a valid checksum", () => {
    const tar = gunzipSync(Buffer.from(encodeWorkspaceArchive(JSON.stringify(bundle))));
    const entry = firstTarEntry(tar);
    expect(entry.name).toBe("workspace.json");
    expect(entry.checksumValid).toBe(true);
    expect(entry.size).toBe(Buffer.byteLength(JSON.stringify(bundle), "utf8"));
  });

  it("handles a large-ish bundle with correct octal size + 512-byte padding", () => {
    const big = { app: "xano", type: "workspace", payload: { blob: "x".repeat(120_000) } };
    const json = JSON.stringify(big);
    const tar = gunzipSync(Buffer.from(encodeWorkspaceArchive(json)));
    const entry = firstTarEntry(tar);
    expect(entry.size).toBe(Buffer.byteLength(json, "utf8"));
    // header (512) + content padded up to a 512 boundary + two 512 zero blocks
    const padded = Math.ceil(entry.size / 512) * 512;
    expect(tar.length).toBe(512 + padded + 1024);
    expect(decodeWorkspaceArchive(encodeWorkspaceArchive(json))).toEqual(big);
  });
});
