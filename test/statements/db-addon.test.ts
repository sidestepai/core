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
import { c, out, inp } from "../../src/values/value.js";

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

  // A paged `list` query returns a metadata envelope whose rows live under
  // `items[]`, so top-level addons must graft at `items[].<alias>` — the same
  // prefix the frontend's return-type editor applies (`openReturn`). Grafting at
  // the envelope root (no offset) silently fails to apply the addon.
  const followers = table({
    name: "follower",
    schema: { follower: f.int(), followee: f.int() },
  });
  const userAddon: AddonSpec = { addon: "user", as: "_user", input: { user_id: out("follower") } };

  describe("paging-envelope offset prefix", () => {
    it("static paging (metadata default) prefixes items[] onto a bare-alias addon", () => {
      const stmt = dbQuery({
        table: followers,
        paging: { per_page: 20 },
        addon: [userAddon],
        as: "rows",
      });
      const a = stmt.addon as { offset?: string; as: string }[];
      expect(a[0]!.offset).toBe("items[]");
      expect(a[0]!.as).toBe("_user");
    });

    it("input-bound paging (Value page) prefixes items[] too", () => {
      const stmt = dbQuery({
        table: followers,
        paging: { page: inp("page") },
        addon: [userAddon],
        as: "rows",
      });
      expect((stmt.addon as { offset?: string }[])[0]!.offset).toBe("items[]");
    });

    it("is idempotent — an author who wrote items[] is not double-prefixed", () => {
      const explicit: AddonSpec = { addon: "user", as: "items[]._user" };
      const stmt = dbQuery({ table: followers, paging: { per_page: 20 }, addon: [explicit], as: "rows" });
      expect((stmt.addon as { offset?: string }[])[0]!.offset).toBe("items[]");
    });

    it("nests the prefix ahead of an authored offset segment", () => {
      const nested: AddonSpec = { addon: "user", as: "obj._user" };
      const stmt = dbQuery({ table: followers, paging: { per_page: 20 }, addon: [nested], as: "rows" });
      expect((stmt.addon as { offset?: string }[])[0]!.offset).toBe("items[].obj");
    });

    it("metadata:false (bare array) emits no items[] prefix", () => {
      const stmt = dbQuery({
        table: followers,
        paging: { per_page: 20, metadata: false },
        addon: [userAddon],
        as: "rows",
      });
      expect((stmt.addon as { offset?: string }[])[0]!.offset).toBeUndefined();
    });

    it("no paging (plain list) emits no items[] prefix", () => {
      const stmt = dbQuery({ table: followers, addon: [userAddon], as: "rows" });
      expect((stmt.addon as { offset?: string }[])[0]!.offset).toBeUndefined();
    });

    it("a classic external blob forces the envelope and prefixes items[]", () => {
      const stmt = dbQuery({
        table: followers,
        external: { value: inp("filters") },
        addon: [userAddon],
        as: "rows",
      });
      expect((stmt.addon as { offset?: string }[])[0]!.offset).toBe("items[]");
    });

    it("a non-list returnType (single) never prefixes items[]", () => {
      const stmt = dbQuery({
        table: followers,
        returnType: "single",
        addon: [userAddon],
        as: "row",
      });
      expect((stmt.addon as { offset?: string }[])[0]!.offset).toBeUndefined();
    });

    it("only top-level addons get the prefix — nested children graft relative to their parent", () => {
      const withChild: AddonSpec = {
        addon: "user",
        as: "_user",
        children: [{ addon: "profile", as: "obj._profile" }],
      };
      const stmt = dbQuery({ table: followers, paging: { per_page: 20 }, addon: [withChild], as: "rows" });
      const top = (stmt.addon as { offset?: string; children?: { offset?: string }[] }[])[0]!;
      expect(top.offset).toBe("items[]");
      expect(top.children![0]!.offset).toBe("obj");
    });

    it("single-row ops (db.get) never prefix even with paging-shaped siblings", () => {
      const get = dbGet({ table: followers, fieldValue: c.int(1), addon: [userAddon] });
      expect((get.addon as { offset?: string }[])[0]!.offset).toBeUndefined();
    });
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
