/**
 * Addon attachment on the row-returning db ops (`db.query`/`get`/`add`/`edit`/
 * `patch`). Proves the `addon` arg threads through the shared envelope into the
 * stored `addon[]` block, and that omitting it preserves the empty-`addon:[]`
 * default byte-for-byte (R1). The encoded shape itself is covered by
 * `addon-encode.test.ts`; here we prove the wiring and the exclusions (R8).
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import {
  dbQuery,
  dbGet,
  dbAdd,
  dbEdit,
  dbPatch,
  dbAddOrEdit,
  dbDel,
  dbHas,
  dbTruncate,
} from "../../src/statements/special/db.js";
import { encodeAddons } from "../../src/statements/special/addon-encode.js";
import type { AddonSpec } from "../../src/statements/special/addon-encode.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { c, out } from "../../src/values/value.js";

const note = table({
  name: "note",
  schema: { user_id: f.int(), title: f.text(), body: f.text() },
});

const spec: AddonSpec = {
  addon: "author",
  as: "items._author",
  input: { user_id: out("user_id") },
  output: ["name"],
};

describe("db op addon threading", () => {
  it("db.query emits the encoded addon block", () => {
    const stmt = dbQuery({ table: note, addon: [spec], as: "rows" });
    expect(stmt.addon).toEqual(encodeAddons([spec]));
    expect(stmt.addon).toHaveLength(1);
  });

  it("db.query with addon leaves the rest of the statement identical to no-addon", () => {
    const withAddon = dbQuery({ table: note, addon: [spec], as: "rows" });
    const without = dbQuery({ table: note, as: "rows" });
    expect({ ...withAddon, addon: undefined }).toEqual({ ...without, addon: undefined });
  });

  it("db.get / add / edit / patch each carry the addon block in the envelope", () => {
    const get = dbGet({ table: note, fieldValue: c.int(1), addon: [spec] });
    const add = dbAdd({ table: note, row: { title: c.text("x") }, addon: [spec] });
    const edit = dbEdit({ table: note, fieldValue: c.int(1), row: { title: c.text("x") }, addon: [spec] });
    const patch = dbPatch({ table: note, fieldValue: c.int(1), data: c.obj({}), addon: [spec] });
    for (const stmt of [get, add, edit, patch]) {
      expect(stmt.addon).toEqual(encodeAddons([spec]));
    }
  });

  it("omitting addon yields an empty addon:[] (R1 regression guard)", () => {
    expect(dbQuery({ table: note, as: "rows" }).addon).toEqual([]);
    expect(dbGet({ table: note, fieldValue: c.int(1) }).addon).toEqual([]);
    expect(dbAdd({ table: note, row: { title: c.text("x") } }).addon).toEqual([]);
    expect(dbEdit({ table: note, fieldValue: c.int(1), row: { title: c.text("x") } }).addon).toEqual([]);
    expect(dbPatch({ table: note, fieldValue: c.int(1), data: c.obj({}) }).addon).toEqual([]);
  });

  it("a nested addon on db.query round-trips to the stored children shape", () => {
    const nested: AddonSpec = {
      addon: "author",
      as: "items._author",
      children: [{ addon: "profile", as: "obj._profile" }],
    };
    const stmt = dbQuery({ table: note, addon: [nested], as: "rows" });
    const built = stmt.addon as { children?: unknown[] }[];
    expect(built[0]!.children).toHaveLength(1);
    expect((built[0]!.children as { as: string }[])[0]!.as).toBe("_profile");
  });

  it("addon-less ops (add_or_edit / del / has / truncate) reject an addon arg", () => {
    // @ts-expect-error db.add_or_edit uses the lean envelope — no addon slot (R8).
    dbAddOrEdit({ table: note, fieldValue: c.int(1), row: { title: c.text("x") }, addon: [spec] });
    // @ts-expect-error db.del returns no row to enrich (R8).
    dbDel({ table: note, fieldValue: c.int(1), addon: [spec] });
    // @ts-expect-error db.has returns a boolean, not a row (R8).
    dbHas({ table: note, fieldValue: c.int(1), addon: [spec] });
    // @ts-expect-error db.truncate returns nothing (R8).
    dbTruncate({ table: note, addon: [spec] });
  });
});
