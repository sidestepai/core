import { describe, it, expect } from "vitest";
import { encodeTable, encodeColumn, encodeIndex, tableColumns, tableIndexes, tableKind } from "../../src/kinds/table.js";
import { Xano } from "../../src/workspace/xano.js";
import "../../src/kinds/workspace-config.js"; // side-effect: register the "workspace" kind
import { normalize, loadFixture } from "../conformance/harness.js";

interface TableFixture {
  schema: Array<Record<string, unknown>>;
  index: Array<Record<string, unknown>>;
  autocomplete: unknown;
  external: unknown;
  as: string;
  auth: boolean;
}
const fixture = loadFixture<TableFixture>("tables/schema-table.json");
const col = (name: string) => fixture.schema.find((c) => c.name === name)!;
const idxByType = (type: string) => fixture.index.find((i) => i.type === type)!;

describe("table kind", () => {
  it("lands under payload key 'dbo'", () => {
    expect(tableKind.payloadKey).toBe("dbo");
  });

  it("encodes columns to the fixture column shapes (via shared field encoder)", () => {
    expect(normalize(encodeColumn({ name: "id", type: "int", required: true }))).toEqual(
      normalize(col("id")),
    );
    expect(
      normalize(encodeColumn({ name: "created_at", type: "epochms", default: "now", access: "private" })),
    ).toEqual(normalize(col("created_at")));
  });

  it("encodes indexes to the fixture index shapes", () => {
    expect(normalize(encodeIndex({ type: "primary", fields: [{ name: "id" }] }))).toEqual(
      normalize(idxByType("primary")),
    );
    expect(
      normalize(encodeIndex({ type: "btree", fields: [{ name: "created_at", op: "desc" }] })),
    ).toEqual(normalize(idxByType("btree")));
    expect(
      normalize(encodeIndex({ type: "gin", fields: [{ name: "xdo", op: "jsonb_path_op" }] })),
    ).toEqual(normalize(idxByType("gin")));
    expect(
      normalize(encodeIndex({ type: "btree|unique", fields: [{ name: "email", op: "asc" }] })),
    ).toEqual(normalize(idxByType("btree|unique")));
  });

  it("encodes the table envelope (auth, autocomplete, external, sql_name, market_item)", () => {
    const t = encodeTable({
      name: "user",
      auth: true,
      schema: [{ name: "id", type: "int", required: true }],
      autocomplete: ["email", "id"],
    });
    expect(t.auth).toBe(true);
    expect(t.install).toBe(false);
    expect(t.autocomplete).toEqual([{ name: "email" }, { name: "id" }]);
    expect(t.external).toEqual({ source: "", id: "" });
    expect(t.views).toEqual([]);
    expect(t.tag).toEqual([]);
    // A table has no `as` — it returns nothing (it's a datastore, not a statement).
    expect(t).not.toHaveProperty("as");
    // The engine persists an empty physical name; it derives the real one.
    expect(t.sql_name).toBe("");
    expect(t.market_item).toEqual({ id: 0, version: 0, guid: "" });
  });

  it("requires a name", () => {
    // @ts-expect-error - missing name
    expect(() => encodeTable({ schema: [] })).toThrow(/name/);
  });

  it("registers on Xano under payload.dbo", () => {
    const bundle = new Xano()
      .register("table", { name: "user", schema: [{ name: "id", type: "int", required: true }] })
      .export();
    expect(bundle.payload.dbo).toHaveLength(1);
    expect((bundle.payload.dbo as any)[0].name).toBe("user");
  });

  it("decorates each dbo with the package-export import directive", () => {
    // The engine's importWorkspace switches on `import.mode`; a dbo without an
    // `import` block fatals ("Undefined array key 'import'"). "standard" =
    // create-or-update by guid. Only dbos carry it (Export.php::exportSchema),
    // not the stored dbo form, so it's added at export, not in encodeTable.
    const bundle = new Xano()
      .register("table", { name: "user", schema: [] })
      .export();
    expect((bundle.payload.dbo as any)[0].import).toEqual({ mode: "standard" });
  });

  it("tables inherit the workspace use_xdo (order-independent), per-table override wins", () => {
    const bundle = new Xano()
      .registerTables([
        { name: "inherits", schema: [] },
        { name: "opts_out", schema: [], useXdo: false },
      ])
      // workspace registered AFTER the tables — still resolved at export
      .registerWorkspace({ name: "app", use_xdo: true })
      .export();
    const dbo = bundle.payload.dbo as Array<{ name: string; use_xdo: boolean; index: Array<{ type: string }> }>;
    const inherits = dbo.find((t) => t.name === "inherits")!;
    const optsOut = dbo.find((t) => t.name === "opts_out")!;
    expect(inherits.use_xdo).toBe(true);
    expect(inherits.index.map((i) => i.type)).toEqual(["primary", "gin", "btree"]);
    expect(optsOut.use_xdo).toBe(false);
    expect(optsOut.index.map((i) => i.type)).toEqual(["primary", "btree"]);
  });

  it("tables default to use_xdo false when the workspace doesn't set it", () => {
    const bundle = new Xano()
      .registerWorkspace({ name: "app" })
      .registerTables([{ name: "t", schema: [] }])
      .export();
    expect((bundle.payload.dbo as Array<{ use_xdo: boolean }>)[0]?.use_xdo).toBe(false);
  });

  // Rich field types (U10): array columns and nested object children.
  it("encodes an array column to style.type 'list' (num: int[])", () => {
    expect(normalize(encodeColumn({ name: "num", type: "int", array: true }))).toEqual(
      normalize(col("num")),
    );
  });

  it("encodes a nested object column with recursive children (hehe)", () => {
    const hehe = encodeColumn({
      name: "hehe",
      type: "obj",
      children: [
        { name: "names", type: "text", array: true, methods: ["trim"] },
        { name: "obj", type: "obj", children: [{ name: "name", type: "text", methods: ["trim"] }] },
        {
          name: "obj2",
          type: "obj",
          array: true,
          children: [{ name: "name", type: "text", methods: ["trim"] }],
        },
      ],
    });
    expect(normalize(hehe)).toEqual(normalize(col("hehe")));
  });

  it("encodes an enum column's values[] (byte-exact vs golden)", () => {
    const enumFixture = loadFixture<Record<string, unknown>>("fields/enum-action.json");
    const action = encodeColumn({
      name: "action",
      type: "enum",
      values: ["message", "join"],
      default: "message",
      required: true,
    });
    expect(normalize(action)).toEqual(normalize(enumFixture));
  });

  it("auto-injects an int `id` system column by default", () => {
    const id = tableColumns({ schema: [] }).find((c) => c.name === "id");
    expect(id).toEqual({ name: "id", type: "int", required: true });
  });

  it("auto-injects a uuid `id` when idType is 'uuid'", () => {
    const id = tableColumns({ schema: [], idType: "uuid" }).find((c) => c.name === "id");
    expect(id).toEqual({ name: "id", type: "uuid", required: true });
  });

  it("respects an author-declared `id` over idType", () => {
    const cols = tableColumns({ schema: [{ name: "id", type: "int", required: true }], idType: "uuid" });
    expect(cols.filter((c) => c.name === "id")).toEqual([{ name: "id", type: "int", required: true }]);
  });

  it("omits the gin(xdo) index by default (use_xdo false → real columns)", () => {
    const idx = tableIndexes({});
    expect(idx.map((i) => i.type)).toEqual(["primary", "btree"]);
  });

  it("adds the gin(xdo) index when useXdo is true (canonical order)", () => {
    const idx = tableIndexes({ useXdo: true });
    expect(idx.map((i) => i.type)).toEqual(["primary", "gin", "btree"]);
    expect(idx.find((i) => i.type === "gin")?.fields).toEqual([{ name: "xdo", op: "jsonb_path_op" }]);
  });

  it("defaults use_xdo to false in the encoded table", () => {
    expect(encodeTable({ name: "post", schema: [] }).use_xdo).toBe(false);
    expect(encodeTable({ name: "post", schema: [], useXdo: true }).use_xdo).toBe(true);
  });
});
