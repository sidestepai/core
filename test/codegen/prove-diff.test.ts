/**
 * U1: the declined-proof recorder. Two contracts matter — the differ names the
 * key path a maintainer needs, and the recorder is genuinely inert unless
 * `SIDESTEP_PROVE_DIFF` is set (it is shipped code that runs on every user's
 * decode path, so an accidental write or an unbounded walk would be a real bug).
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffKeyPaths, recordProveAbort, recordProveDecline } from "../../src/codegen/prove-diff.js";

interface Record_ {
  arm: string;
  name: unknown;
  diffs: string[];
}

const dirs: string[] = [];
function sinkPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "prove-diff-"));
  dirs.push(dir);
  return join(dir, "diff.jsonl");
}

afterEach(() => {
  delete process.env["SIDESTEP_PROVE_DIFF"];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readRecords(file: string): Record_[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record_);
}

describe("prove-diff — the key-path differ", () => {
  it("names a key present only in the encoded side", () => {
    expect(diffKeyPaths({ context: { access: "public" } }, { context: {} })).toEqual([
      '.context.access: EXTRA in encoded ("public")',
    ]);
  });

  it("names a key present only in the stored side", () => {
    expect(diffKeyPaths({}, { disabled: true })).toEqual([
      ".disabled: MISSING from encoded (stored=true)",
    ]);
  });

  it("names a scalar disagreement with both values", () => {
    expect(diffKeyPaths({ as: "a" }, { as: "b" })).toEqual(['.as: encoded="a" stored="b"']);
  });

  it("names an array length disagreement", () => {
    expect(diffKeyPaths({ input: [1, 2] }, { input: [1] })).toEqual([
      ".input: length encoded=2 stored=1",
    ]);
  });

  it("names an object-vs-array shape disagreement", () => {
    expect(diffKeyPaths({ context: {} }, { context: [] })).toEqual([
      ".context: shape encoded=object stored=array",
    ]);
  });

  it("collapses sibling array entries diverging the same way into one signature", () => {
    const encoded = { addon: [{ offset: "x" }, { offset: "x" }, { offset: "x" }] };
    const stored = { addon: [{ offset: "" }, { offset: "" }, { offset: "" }] };
    // Indices collapse to `[]`, so three identical divergences read as one path.
    expect(new Set(diffKeyPaths(encoded, stored))).toEqual(
      new Set(['.addon[].offset: encoded="x" stored=""']),
    );
  });

  it("returns nothing for equal values", () => {
    expect(diffKeyPaths({ a: 1, b: [{ c: null }] }, { a: 1, b: [{ c: null }] })).toEqual([]);
  });

  it("clips a long disagreeing value rather than quoting it whole", () => {
    const [entry] = diffKeyPaths({ value: "x".repeat(500) }, { value: "" });
    expect(entry).toBeDefined();
    expect(entry!.length).toBeLessThan(200);
    expect(entry).toContain("…");
  });

  it("terminates on a divergence deeper than the depth cap", () => {
    const deep = (depth: number, leaf: unknown): unknown =>
      depth === 0 ? leaf : { next: deep(depth - 1, leaf) };
    // 40 levels down — well past the cap — must return, not recurse without bound.
    expect(diffKeyPaths(deep(40, "a"), deep(40, "b"))).toEqual([]);
  });

  it("bounds the number of paths for a statement that diverges everywhere", () => {
    const encoded: Record<string, unknown> = {};
    const stored: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      encoded[`k${i}`] = i;
      stored[`k${i}`] = i + 1;
    }
    const diffs = diffKeyPaths(encoded, stored);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.length).toBeLessThanOrEqual(40);
  });

  it("walks nested divergence to its actual path", () => {
    const encoded = { context: { expr: { expression: [{ group: { expression: [] } }] } } };
    const stored = { context: { expr: { expression: [{}] } } };
    expect(diffKeyPaths(encoded, stored)).toEqual([
      '.context.expr.expression[].group: EXTRA in encoded ({"expression":[]})',
    ]);
  });
});

describe("prove-diff — the recorder", () => {
  it("writes nothing and creates no file when the variable is unset", () => {
    const file = sinkPath();
    recordProveDecline("special", "mvp:set_var", { a: 1 }, { a: 2 });
    recordProveAbort("special", "mvp:set_var", "factory threw");
    expect(existsSync(file)).toBe(false);
  });

  it("writes nothing when the variable is set but empty", () => {
    const file = sinkPath();
    process.env["SIDESTEP_PROVE_DIFF"] = "";
    recordProveDecline("special", "mvp:set_var", { a: 1 }, { a: 2 });
    expect(existsSync(file)).toBe(false);
  });

  it("appends one line per decline, carrying the arm and the stored name", () => {
    const file = sinkPath();
    process.env["SIDESTEP_PROVE_DIFF"] = file;
    recordProveDecline("special", "mvp:set_var", {}, { disabled: true });
    recordProveDecline("spec:api.request", "mvp:api_request", { context: {} }, { context: [] });

    const records = readRecords(file);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      arm: "special",
      name: "mvp:set_var",
      diffs: [".disabled: MISSING from encoded (stored=true)"],
    });
    // The arm distinguishes a spec inverse that cannot invert from a special that
    // declines — the same stored name reaches both.
    expect(records[1]!.arm).toBe("spec:api.request");
  });

  it("records an abort distinguishably from a byte mismatch", () => {
    const file = sinkPath();
    process.env["SIDESTEP_PROVE_DIFF"] = file;
    recordProveAbort("spec:db.query", "mvp:dbo_view", "factory threw: TypeError");

    const records = readRecords(file);
    expect(records).toHaveLength(1);
    expect(records[0]!.diffs[0]).toMatch(/^ABORT: /);
  });

  it("emits one line per record even when a diff spans many paths", () => {
    const file = sinkPath();
    process.env["SIDESTEP_PROVE_DIFF"] = file;
    recordProveDecline("special", "mvp:dbo_view", { a: 1, b: 2, c: 3 }, { a: 9, b: 9, c: 9 });
    expect(readRecords(file)).toHaveLength(1);
  });
});
