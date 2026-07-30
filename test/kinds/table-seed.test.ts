import { describe, it, expect, expectTypeOf } from "vitest";
import { table, encodeTable } from "../../src/kinds/table.js";
import type { InferRow } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { s } from "../../src/statements/s.js";

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
    expect(table({ ...base, seed: [{ name: "a", qty: 1 }] }).seed).toBeDefined();
    expect(table({ ...base, seed: [{ id: 7, name: "a", qty: 1 }] }).seed).toBeDefined();
    // A misspelled column is now an author-time error too (it was silently
    // accepted while the loose overload could swallow the call — see below).
    // @ts-expect-error - `qty` misspelled
    expect(table({ ...base, seed: [{ name: "a", qtyy: 1 }] }).seed).toBeDefined();
  });

  /**
   * #164 — a function-form `seed` used to make the call fall through to the loose
   * `table(def: TableDef)` overload, collapsing BOTH the row type (`InferRow` →
   * `unknown`) and the column-name union (so a misspelled column stopped being
   * caught in every db statement taking the table), with no error at the
   * `table()` call. The regression is type-level, so these assertions are the
   * test: `npm run typecheck` fails if inference collapses again.
   */
  describe("typing survives every seed form (#164)", () => {
    const inline = table({ ...base, seed: [{ name: "a", qty: 1 }] });
    const thunk = table({ ...base, seed: () => [{ name: "a", qty: 1 }] });
    const asyncThunk = table({ ...base, seed: async () => [{ name: "a", qty: 1 }] });
    const promiseThunk = table({
      ...base,
      seed: () => Promise.resolve([{ name: "a", qty: 1 }]),
    });

    it("keeps the row type inferrable through a thunk", () => {
      // The inline-seed form always inferred correctly; it is the baseline every
      // deferred form must match.
      type Row = InferRow<typeof inline>;
      expectTypeOf<Row>().toEqualTypeOf<{
        id: number;
        created_at: number;
        readonly name: string;
        readonly qty: number;
      }>();
      expectTypeOf<InferRow<typeof thunk>>().toEqualTypeOf<Row>();
      expectTypeOf<InferRow<typeof asyncThunk>>().toEqualTypeOf<Row>();
      expectTypeOf<InferRow<typeof promiseThunk>>().toEqualTypeOf<Row>();
      for (const t of [inline, thunk, asyncThunk, promiseThunk]) expect(t.seed).toBeDefined();
    });

    it("treats a column without `required` as an optional seed key", () => {
      // The runtime leaves an absent column absent and the engine applies its
      // default, so demanding every column here was stricter than either (#164).
      // A `required` column is still demanded, and `null` still needs `nullable`.
      const partial = table({ ...base, seed: [{ name: "a" }, { qty: 2 }, {}] });
      expect(partial.seed).toHaveLength(3);
      const strict = { name: "w2", schema: { sku: f.text({ required: true }) } };
      // @ts-expect-error - `sku` is required
      expect(table({ ...strict, seed: [{}] }).seed).toBeDefined();
      // @ts-expect-error - `name` is not nullable
      expect(table({ ...base, seed: [{ name: null }] }).seed).toBeDefined();
      expect(table({ ...base, seed: [{ name: "a", qty: 1 }] }).seed).toBeDefined();
    });

    it("keeps the column-name union so statements still catch a typo", () => {
      expect(s.db.query({ table: thunk, sort: [{ sortBy: "qty" }], as: "rows" })).toBeDefined();
      // @ts-expect-error - not a column of `widgets`
      expect(s.db.query({ table: thunk, sort: [{ sortBy: "nope" }], as: "rows" })).toBeDefined();
    });
  });
});
