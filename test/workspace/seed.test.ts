import { describe, it, expect } from "vitest";
import {
  resolveSeedRows,
  coerceSeedRows,
  paginateRows,
  buildSeedContentFiles,
} from "../../src/workspace/seed.js";
import { buildContentEnvelope, calcSignatureJson } from "../../src/workspace/export.js";
import { table, tableColumns } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { deriveGuid } from "../../src/refs/guid.js";

const products = table({
  name: "products",
  schema: {
    name: f.text({ required: true }),
    price: f.decimal(),
    qty: f.int(),
    active: f.bool(),
    launched_at: f.timestamp(),
    sku: f.uuid(),
    meta: f.json(),
  },
});

const cols = tableColumns(products);

describe("resolveSeedRows", () => {
  it("accepts an array, a sync thunk, and an async thunk", async () => {
    const rows = [{ name: "a" }];
    expect(await resolveSeedRows(rows)).toEqual(rows);
    expect(await resolveSeedRows(() => rows)).toEqual(rows);
    expect(await resolveSeedRows(async () => rows)).toEqual(rows);
  });

  it("throws when a source resolves to a non-array", async () => {
    // @ts-expect-error — exercising the runtime guard on a bad source
    await expect(resolveSeedRows(() => ({}))).rejects.toThrow(/did not resolve to an array/);
  });
});

describe("coerceSeedRows", () => {
  it("coerces each column category to its wire form (happy path)", () => {
    const out = coerceSeedRows("products", cols, [
      { name: "Widget", price: 9.99, qty: 3, active: true, sku: "abc", meta: { k: 1 } },
    ]);
    expect(out).toEqual([
      { name: "Widget", price: 9.99, qty: 3, active: true, sku: "abc", meta: { k: 1 } },
    ]);
  });

  it("converts a Date (and ISO string) to epoch-ms for a timestamp column", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    const [row] = coerceSeedRows("products", cols, [{ name: "x", launched_at: d }]);
    expect(row!.launched_at).toBe(d.getTime());
    const [row2] = coerceSeedRows("products", cols, [{ name: "x", launched_at: "2026-01-02T03:04:05.000Z" }]);
    expect(row2!.launched_at).toBe(d.getTime());
  });

  it("keeps the system id/created_at columns optional and honors an explicit id", () => {
    expect(coerceSeedRows("products", cols, [{ name: "x" }])).toEqual([{ name: "x" }]);
    const [row] = coerceSeedRows("products", cols, [{ id: 42, name: "x" }]);
    expect(row!.id).toBe(42);
  });

  it("passes null through (nullability is the engine's to enforce)", () => {
    expect(coerceSeedRows("products", cols, [{ name: "x", price: null }])).toEqual([
      { name: "x", price: null },
    ]);
  });

  it("treats an explicit undefined value as an omitted column (JSON semantics)", () => {
    expect(coerceSeedRows("products", cols, [{ name: "x", price: undefined }])).toEqual([
      { name: "x" },
    ]);
  });

  it("rejects an unknown column, naming table + row + known columns", () => {
    expect(() => coerceSeedRows("products", cols, [{ name: "x", nope: 1 }])).toThrow(
      /table "products", seed row 0: unknown column "nope"/,
    );
  });

  it("rejects an un-coercible value, naming table + row + column + type", () => {
    expect(() => coerceSeedRows("products", cols, [{ name: "x", qty: "lots" }])).toThrow(
      /table "products", seed row 0, column "qty" \(int\): expected a number/,
    );
    expect(() => coerceSeedRows("products", cols, [{ name: 5 }])).toThrow(
      /column "name" \(text\): expected a string/,
    );
  });

  it("rejects a non-object row", () => {
    // @ts-expect-error — exercising the runtime guard on a bad row
    expect(() => coerceSeedRows("products", cols, [["x"]])).toThrow(/expected a row object, got array/);
  });
});

describe("buildContentEnvelope", () => {
  it("wraps rows as a signed type:content envelope whose sig verifies", () => {
    const rows = [{ id: 1, name: "a" }];
    const env = buildContentEnvelope(rows);
    expect(env.app).toBe("xano");
    expect(env.version).toBe("1.03");
    expect(env.type).toBe("content");
    expect(env.payload).toEqual(rows);
    const { sig, ...unsigned } = env;
    expect(sig).toBe(calcSignatureJson(unsigned));
  });
});

describe("paginateRows", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i, pad: "x".repeat(100) }));

  it("returns a single page under budget and splits over budget", () => {
    expect(paginateRows(rows)).toHaveLength(1);
    const pages = paginateRows(rows, 300); // ~110 bytes/row → ~2-3 rows per page
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(rows);
  });

  it("keeps a single oversized row whole, and returns [] for no rows", () => {
    expect(paginateRows([{ big: "x".repeat(1000) }], 10)).toHaveLength(1);
    expect(paginateRows([], 10)).toEqual([]);
  });
});

describe("buildSeedContentFiles", () => {
  it("keys files by the table's dbo guid and page number, with coerced payloads", async () => {
    const seeded = table({
      name: "widgets",
      schema: { name: f.text() },
      seed: [{ name: "a" }, { name: "b" }],
    });
    const files = await buildSeedContentFiles([seeded]);
    const guid = deriveGuid("dbo", "widgets");
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe(`content/${guid}-1.json`);
    const env = JSON.parse(files[0]!.content) as { type: string; payload: unknown[] };
    expect(env.type).toBe("content");
    expect(env.payload).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("emits nothing for tables without seed, or with an empty seed", async () => {
    const noSeed = table({ name: "a", schema: { name: f.text() } });
    const emptySeed = table({ name: "b", schema: { name: f.text() }, seed: [] });
    expect(await buildSeedContentFiles([noSeed, emptySeed])).toEqual([]);
  });

  it("resolves an async thunk source", async () => {
    const seeded = table({
      name: "async_tbl",
      schema: { name: f.text() },
      seed: async () => [{ name: "z" }],
    });
    const files = await buildSeedContentFiles([seeded]);
    expect(files).toHaveLength(1);
    const env = JSON.parse(files[0]!.content) as { payload: unknown[] };
    expect(env.payload).toEqual([{ name: "z" }]);
  });

  it("paginates a large seed into contiguous page files under one guid", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ name: "x".repeat(20_000) + i }));
    const seeded = table({ name: "bulk", schema: { name: f.text() }, seed: rows });
    const files = await buildSeedContentFiles([seeded]);
    const guid = deriveGuid("dbo", "bulk");
    expect(files.length).toBeGreaterThan(1);
    files.forEach((file, i) => expect(file.name).toBe(`content/${guid}-${i + 1}.json`));
    // Every row survives across the pages.
    const all = files.flatMap((file) => (JSON.parse(file.content) as { payload: unknown[] }).payload);
    expect(all).toHaveLength(50);
  });

  it("honors an explicit table guid for content-file keying", async () => {
    const seeded = table({ name: "pinned", guid: "deadbeefdeadbeefdeadbeefdeadbeef", schema: { name: f.text() }, seed: [{ name: "a" }] });
    const files = await buildSeedContentFiles([seeded]);
    expect(files[0]!.name).toBe("content/deadbeefdeadbeefdeadbeefdeadbeef-1.json");
  });
});
