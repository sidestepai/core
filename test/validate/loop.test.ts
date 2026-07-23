import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidateLoop, deepDiff, runnableFunctionNames, type LoopClient, type RoundTripEntry } from "../../src/validate/loop.js";
import { captureFixtures } from "../../src/validate/capture.js";
import { normalize } from "../../src/validate/normalize.js";

function bundleWith(payload: Record<string, unknown>): string {
  return JSON.stringify({ app: "xano", payload });
}

function fakeClient(over: Partial<LoopClient> = {}): LoopClient {
  return {
    importBundle: async () => ({ workspaceId: 42, baseUrl: undefined, raw: "{}" }),
    exportWorkspace: async () => ({ payload: { function: [{ name: "f", run: [] }] } }),
    ...over,
  };
}

describe("runValidateLoop", () => {
  it("accepts and round-trips a matching function (server keys stripped)", async () => {
    const bundle = bundleWith({ function: [{ name: "f", run: [] }] });
    const client = fakeClient({
      // exported object carries id/created_at/guid — normalize drops them → match
      exportWorkspace: async () => ({ payload: { function: [{ id: 5, name: "f", run: [], created_at: 123, guid: "abc" }] } }),
    });
    const res = await runValidateLoop(client, bundle);
    expect(res.accepted).toBe(true);
    expect(res.workspaceId).toBe(42);
    expect(res.roundTrip).toEqual([
      { kind: "function", name: "f", status: "match", diffs: [], fetched: expect.any(Object) },
    ]);
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
      exportWorkspace: async () => ({ payload: { function: [{ id: 5, name: "f", run: [{ name: "x2" }] }] } }),
    });
    const res = await runValidateLoop(client, bundle);
    const entry = res.roundTrip[0]!;
    expect(entry.status).toBe("diff");
    expect(entry.diffs).toContainEqual({ path: "$.run[0].name", expected: "x1", actual: "x2" });
  });

  it("marks a function missing from the exported workspace", async () => {
    const bundle = bundleWith({ function: [{ name: "ghost" }] });
    const client = fakeClient({ exportWorkspace: async () => ({ payload: { function: [{ name: "f" }] } }) });
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
    // Present-but-unreadable: the function is reported unchecked, not dropped.
    expect(res.unchecked).toContainEqual({ kind: "function", count: 1 });
  });

  it("round-trips a table (dbo) with server keys stripped → match", async () => {
    const bundle = bundleWith({ dbo: [{ guid: "g1", name: "user", schema: [{ name: "id" }] }] });
    const client = fakeClient({
      exportWorkspace: async () => ({
        payload: { dbo: [{ id: 2, guid: "g1", name: "user", schema: [{ name: "id" }], created_at: "x" }] },
      }),
    });
    const res = await runValidateLoop(client, bundle);
    expect(res.roundTrip).toEqual([
      { kind: "dbo", name: "user", status: "match", diffs: [], fetched: expect.any(Object) },
    ]);
  });

  it("flags a table schema divergence at the exact path", async () => {
    const bundle = bundleWith({ dbo: [{ guid: "g1", name: "user", schema: [{ name: "id" }] }] });
    const client = fakeClient({
      exportWorkspace: async () => ({ payload: { dbo: [{ guid: "g1", name: "user", schema: [{ name: "uid" }] }] } }),
    });
    const res = await runValidateLoop(client, bundle);
    const entry = res.roundTrip[0]!;
    expect(entry.kind).toBe("dbo");
    expect(entry.status).toBe("diff");
    expect(entry.diffs).toContainEqual({ path: "$.schema[0].name", expected: "id", actual: "uid" });
  });

  it("labels each entry with its kind across a mixed bundle", async () => {
    const bundle = bundleWith({ dbo: [{ name: "t", schema: [] }], function: [{ name: "f", run: [] }] });
    const client = fakeClient({
      exportWorkspace: async () => ({
        payload: { dbo: [{ name: "t", schema: [] }], function: [{ name: "f", run: [] }] },
      }),
    });
    const res = await runValidateLoop(client, bundle);
    // Registry order: dbo before function.
    expect(res.roundTrip.map((e) => [e.kind, e.status])).toEqual([
      ["dbo", "match"],
      ["function", "match"],
    ]);
  });

  it("demotes a registered kind with an empty fetched array to unchecked (no false missing)", async () => {
    // `tool` is registered but the engine persists it nested under toolset, so the
    // export surfaces no top-level `tool` array. It must be unchecked, not missing.
    const bundle = bundleWith({ function: [{ name: "f", run: [] }], tool: [{ name: "mytool" }] });
    const client = fakeClient({
      exportWorkspace: async () => ({ payload: { function: [{ name: "f", run: [] }] } }),
    });
    const res = await runValidateLoop(client, bundle);
    expect(res.unchecked).toContainEqual({ kind: "tool", count: 1 });
    expect(res.roundTrip.some((e) => e.kind === "tool")).toBe(false);
  });

  it("surfaces an ambiguous match when two fetched objects share an identity", async () => {
    const bundle = bundleWith({ query: [{ name: "dup" }] });
    const client = fakeClient({
      exportWorkspace: async () => ({ payload: { query: [{ name: "dup", a: 1 }, { name: "dup", a: 2 }] } }),
    });
    const res = await runValidateLoop(client, bundle);
    expect(res.roundTrip[0]).toMatchObject({ kind: "query", name: "dup", status: "ambiguous" });
  });
});

describe("runnableFunctionNames", () => {
  it("keeps only imported function-kind entries", () => {
    const entries: RoundTripEntry[] = [
      { kind: "function", name: "f1", status: "match", diffs: [], fetched: {} },
      { kind: "function", name: "f2", status: "diff", diffs: [], fetched: {} },
      { kind: "function", name: "gone", status: "missing", diffs: [], fetched: undefined },
      { kind: "dbo", name: "user", status: "match", diffs: [], fetched: {} },
    ];
    expect(runnableFunctionNames(entries)).toEqual(["f1", "f2"]);
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
  it("writes fetched JSON into kind-scoped subdirs and skips entries without a body", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-capture-"));
    try {
      const written = captureFixtures(
        [
          { kind: "function", name: "f", status: "match", diffs: [], fetched: { name: "f", run: [] } },
          { kind: "dbo", name: "user", status: "match", diffs: [], fetched: { name: "user", schema: [] } },
          { kind: "function", name: "ghost", status: "missing", diffs: [], fetched: undefined },
        ],
        dir,
      );
      expect(written).toHaveLength(2);
      const byName = new Map(written.map((w) => [w.name, w.path]));
      // function goldens live under statements/, tables under tables/ (KTD-5).
      expect(byName.get("f")!).toBe(join(dir, "statements", "f.json"));
      expect(byName.get("user")!).toBe(join(dir, "tables", "user.json"));
      const onDisk = JSON.parse(readFileSync(byName.get("f")!, "utf8"));
      // captured (fetched) normalizes equal to the compiled artifact
      expect(normalize(onDisk)).toEqual(normalize({ name: "f", run: [] }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a flat filename for an unregistered kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-capture-"));
    try {
      const written = captureFixtures(
        [{ kind: "mystery", name: "x", status: "match", diffs: [], fetched: { name: "x" } }],
        dir,
      );
      expect(written[0]!.path).toBe(join(dir, "x.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
