import { describe, it, expect } from "vitest";
import { table, encodeTable } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";

/**
 * U1 — the `seed` carrier rides ON the table def but OFF the persisted schema:
 * `encodeTable` (the `dbo` schema surface) must ignore it entirely, so a seeded
 * table's stored shape is byte-identical to an unseeded one.
 */
describe("table seed carrier", () => {
  const base = { name: "widgets", schema: { name: f.text(), qty: f.int() } } as const;

  it("keeps seed off the encoded TableXdo (schema is identical with or without seed)", () => {
    const unseeded = encodeTable(table(base));
    const seeded = encodeTable(table({ ...base, seed: [{ name: "a", qty: 1 }] }));
    expect(seeded).toEqual(unseeded);
    expect("seed" in seeded).toBe(false);
    expect("data" in seeded).toBe(false);
  });

  it("accepts array, sync-thunk, and async-thunk seed sources on the def", () => {
    expect(table({ ...base, seed: [{ name: "a", qty: 1 }] }).seed).toBeDefined();
    expect(table({ ...base, seed: () => [{ name: "a", qty: 1 }] }).seed).toBeInstanceOf(Function);
    expect(table({ ...base, seed: async () => [{ name: "a", qty: 1 }] }).seed).toBeInstanceOf(Function);
  });

  it("accepts row-shaped seed input (system columns optional)", () => {
    // The typed overload accepts correctly-shaped rows: declared columns, with
    // id/created_at omittable (they carry engine defaults) or an explicit id.
    // NB: a mistyped row is NOT a hard author-time error — TS falls back to the
    // loose `table(def: TableDef)` overload (raw ColumnDef[] support). Runtime
    // coercion is the real, loud enforcement — see coerceSeedRows in seed.test.ts.
    expect(table({ ...base, seed: [{ name: "a", qty: 1 }] }).seed).toBeDefined();
    expect(table({ ...base, seed: [{ id: 7, name: "a", qty: 1 }] }).seed).toBeDefined();
  });
});
