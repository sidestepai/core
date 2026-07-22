import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidateLoop, deepDiff, type LoopClient } from "../../src/validate/loop.js";
import { captureFixtures } from "../../src/validate/capture.js";
import { normalize } from "../../src/validate/normalize.js";

function bundleWith(payload: Record<string, unknown>): string {
  return JSON.stringify({ app: "xano", payload });
}

function fakeClient(over: Partial<LoopClient> = {}): LoopClient {
  return {
    importBundle: async () => ({ workspaceId: 42, baseUrl: undefined, raw: "{}" }),
    listFunctions: async () => [{ id: 5, name: "f" }],
    getFunction: async () => ({ id: 5, name: "f", run: [] }),
    ...over,
  };
}

describe("runValidateLoop", () => {
  it("accepts and round-trips a matching function (server keys stripped)", async () => {
    const bundle = bundleWith({ function: [{ name: "f", run: [] }] });
    const client = fakeClient({
      // engine augments with id/created_at/guid — normalize drops them → match
      getFunction: async () => ({ id: 5, name: "f", run: [], created_at: 123, guid: "abc" }),
    });
    const res = await runValidateLoop(client, bundle);
    expect(res.accepted).toBe(true);
    expect(res.workspaceId).toBe(42);
    expect(res.roundTrip).toEqual([{ name: "f", status: "match", diffs: [], fetched: expect.any(Object) }]);
  });

  it("reports accepted:false with the engine message when import throws", async () => {
    const bundle = bundleWith({ function: [{ name: "f" }] });
    const client = fakeClient({
      importBundle: async () => {
        throw new Error("Deploy to /api:meta/sandbox/bundle failed (422): bad field");
      },
    });
    const res = await runValidateLoop(client, bundle);
    expect(res.accepted).toBe(false);
    expect(res.importError).toMatch(/422/);
    expect(res.roundTrip).toEqual([]);
  });

  it("flags a real divergence at the exact path", async () => {
    const bundle = bundleWith({ function: [{ name: "f", run: [{ name: "x1" }] }] });
    const client = fakeClient({
      getFunction: async () => ({ id: 5, name: "f", run: [{ name: "x2" }] }),
    });
    const res = await runValidateLoop(client, bundle);
    const entry = res.roundTrip[0]!;
    expect(entry.status).toBe("diff");
    expect(entry.diffs).toContainEqual({ path: "$.run[0].name", expected: "x1", actual: "x2" });
  });

  it("marks a function missing from the imported workspace", async () => {
    const bundle = bundleWith({ function: [{ name: "ghost" }] });
    const client = fakeClient({ listFunctions: async () => [{ id: 5, name: "f" }] });
    const res = await runValidateLoop(client, bundle);
    expect(res.roundTrip[0]).toMatchObject({ name: "ghost", status: "missing" });
  });

  it("reports imported-but-unchecked kinds honestly", async () => {
    const bundle = bundleWith({ function: [{ name: "f", run: [] }], query: [{ name: "a" }, { name: "b" }], dbo: [{ name: "t" }] });
    const res = await runValidateLoop(fakeClient(), bundle);
    expect(res.unchecked).toContainEqual({ kind: "query", count: 2 });
    expect(res.unchecked).toContainEqual({ kind: "dbo", count: 1 });
  });

  it("accepts but skips round-trip when no workspace id comes back", async () => {
    const bundle = bundleWith({ function: [{ name: "f" }] });
    const client = fakeClient({ importBundle: async () => ({ workspaceId: undefined, baseUrl: undefined, raw: "{}" }) });
    const res = await runValidateLoop(client, bundle);
    expect(res.accepted).toBe(true);
    expect(res.roundTrip).toEqual([]);
  });
});

describe("deepDiff", () => {
  it("returns [] for equal values", () => {
    expect(deepDiff({ a: [1, 2], b: "x" }, { a: [1, 2], b: "x" })).toEqual([]);
  });
  it("records a leaf mismatch with its path", () => {
    expect(deepDiff({ a: 1 }, { a: 2 })).toEqual([{ path: "$.a", expected: 1, actual: 2 }]);
  });
  it("records array-length differences per index", () => {
    expect(deepDiff([1], [1, 2])).toEqual([{ path: "$[1]", expected: undefined, actual: 2 }]);
  });
  it("flags an object-vs-array shape mismatch at the node", () => {
    expect(deepDiff({ a: 1 }, [1])).toEqual([{ path: "$", expected: { a: 1 }, actual: [1] }]);
  });
});

describe("captureFixtures", () => {
  it("writes fetched JSON per entry and skips entries without a body", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-capture-"));
    try {
      const written = captureFixtures(
        [
          { name: "f", status: "match", diffs: [], fetched: { name: "f", run: [] } },
          { name: "ghost", status: "missing", diffs: [], fetched: undefined },
        ],
        dir,
      );
      expect(written).toHaveLength(1);
      expect(written[0]!.name).toBe("f");
      const onDisk = JSON.parse(readFileSync(written[0]!.path, "utf8"));
      // captured (fetched) normalizes equal to the compiled artifact
      expect(normalize(onDisk)).toEqual(normalize({ name: "f", run: [] }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
