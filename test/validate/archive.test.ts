import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeWorkspaceArchive } from "../../src/validate/archive.js";
import { buildWorkspaceArchive } from "./_helpers.js";

const bundle = { app: "xano", type: "workspace", payload: { function: [{ name: "f", run: [{ name: "mvp:set_var" }] }] } };

describe("decodeWorkspaceArchive", () => {
  it("peels gzip + untars a single workspace.json to the bundle object", () => {
    expect(decodeWorkspaceArchive(buildWorkspaceArchive(bundle))).toEqual(bundle);
  });

  it("handles a double-gzipped archive (as the live endpoint returns)", () => {
    const doubled = gzipSync(Buffer.from(buildWorkspaceArchive(bundle)));
    expect(decodeWorkspaceArchive(doubled)).toEqual(bundle);
  });

  it("throws a clear error when the archive lacks workspace.json", () => {
    // a valid gzip of an empty tar (all-zero blocks) → no entries
    const emptyTar = gzipSync(Buffer.alloc(1024, 0));
    expect(() => decodeWorkspaceArchive(emptyTar)).toThrow(/no workspace\.json/);
  });
});
