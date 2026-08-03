import { describe, it, expect } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import { Xano } from "../../src/workspace/xano.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { encodeTable, encodeColumn, encodeIndex, tableColumns, tableIndexes, tableKind } from "../../src/kinds/table.js";
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

  it("normalizes the `unique` shorthand to `btree|unique` (the literal the engine accepts)", () => {
    // "unique" type-checks (IndexType ends in `string & {}`) and is the obvious
    // thing to write, but Xano rejects it at import with `Invalid index type.`
    // (a 500). It must serialize as "btree|unique". See issue #15.
    expect(encodeIndex({ type: "unique", fields: [{ name: "email" }] }).type).toBe("btree|unique");
    expect(encodeIndex({ type: "unique", fields: [{ name: "email", op: "asc" }] })).toEqual(
      encodeIndex({ type: "btree|unique", fields: [{ name: "email", op: "asc" }] }),
    );
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

  // 4-byte column defaults (issue #45): the engine's default pipeline mangles an
  // astral-plane character (> U+FFFF) into invalid UTF-8, so an emoji default
  // exports cleanly then 500s at deploy with Postgres 22021. Verified against the
  // engine's UTF8 Postgres image — BMP characters store fine; only 4-byte break.
  it("rejects a 4-byte column default, naming the table/column/character", () => {
    expect(() =>
      encodeTable({ name: "habit", schema: [{ name: "emoji", type: "text", default: "🌱" }] }),
    ).toThrow(/table "habit", column "emoji".*4-byte.*U\+1F331.*22021/s);
  });

  it("rejects a 4-byte character hidden in the middle of a BMP string", () => {
    expect(() =>
      encodeTable({ name: "t", schema: [{ name: "c", type: "text", default: "seed 𠀀 me" }] }),
    ).toThrow(/U\+20000/);
  });

  it("accepts BMP non-ASCII defaults (accents, CJK, €) — they deploy fine on the UTF8 DB", () => {
    expect(() =>
      encodeTable({
        name: "t",
        schema: [
          { name: "accent", type: "text", default: "café" },
          { name: "cjk", type: "text", default: "中" },
          { name: "euro", type: "text", default: "€" },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts ASCII column defaults (string, number, boolean)", () => {
    expect(() =>
      encodeTable({
        name: "t",
        schema: [
          { name: "s", type: "text", default: "hello" },
          { name: "n", type: "int", default: 0 },
          { name: "b", type: "bool", default: false },
        ],
      }),
    ).not.toThrow();
  });

  it("scopes the guard to encodeTable — the shared field encoder still accepts 4-byte defaults", () => {
    // encodeColumn/encodeField are shared with function inputs, whose defaults
    // bind at runtime (not DDL) and accept any character. The guard lives in
    // encodeTable, so the low-level encoder must not reject on its own.
    expect(() => encodeColumn({ name: "emoji", type: "text", default: "🌱" })).not.toThrow();
  });

  it("registers on Xano under payload.dbo", () => {
    const bundle = new Xano()
      .register("table", { name: "user", schema: [{ name: "id", type: "int", required: true }] })
      .export();
    expect(bundle.payload.dbo).toHaveLength(1);
    expect((bundle.payload.dbo as any)[0].name).toBe("user");
  });

  it("decorates each dbo with the package-export import directive", () => {
    // The engine's workspace import switches on `import.mode`; a dbo without an
    // `import` block fatals on the missing key. "standard" = create-or-update by
    // guid. Only dbos carry it, and only in the EXPORTED form — not the stored
    // dbo form — so it's added at export, not in encodeTable.
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
    expect(id).toMatchObject({ name: "id", type: "uuid", required: true });
  });

  it("encodes a uuid primary key with NO `default` key at all", () => {
    // The engine persists no `default` for a uuid primary key — its value is
    // engine-generated, so there is nothing for an author default to mean, and
    // absent vs empty are different stored bytes. Writing `default: ""` here
    // produced a shape the engine never writes, so the column could not
    // round-trip through any catalog call and fell back to `rawField()`.
    const encoded = encodeTable({ name: "t", schema: [], idType: "uuid" });
    const id = encoded.schema.find((c) => c.name === "id")!;
    expect(Object.hasOwn(id, "default")).toBe(false);
  });

  it("still encodes an int primary key WITH `default`", () => {
    // The rule is specific to uuid keys — an int key carries `default: ""`.
    const encoded = encodeTable({ name: "t", schema: [] });
    const id = encoded.schema.find((c) => c.name === "id")!;
    expect(id.default).toBe("");
  });

  it("still encodes an ordinary (non-key) uuid column WITH `default`", () => {
    // Guards against widening this to "uuid columns have no default": a
    // persisted engine record in the corpus carries a non-key uuid column with
    // `default: ""`, so only the primary key differs.
    const encoded = encodeTable({ name: "t", schema: [{ name: "ref", type: "uuid" }] });
    const ref = encoded.schema.find((c) => c.name === "ref")!;
    expect(ref.default).toBe("");
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

/**
 * A uuid PRIMARY KEY is the one column the engine persists with no `default`
 * key at all — its value is engine-generated, so there is nothing for a default
 * to mean, and absent vs empty are different stored bytes.
 *
 * Measured read-only across four engine-authored workspaces (114 columns): the
 * single uuid primary key stores no `default`, while a persisted engine record
 * in the fixture corpus carries an ordinary NON-key uuid column WITH
 * `default: ""`. So the rule is the key, not the type — these tests pin both
 * halves so it cannot be widened by accident.
 */
describe("uuid primary key — no `default` key persisted", () => {
  it("round-trips a uuid-key table through encode → decode → encode", () => {
    // The actual 1:1 claim. Before this, encodeField wrote `default: ""` here,
    // which no real Xano workspace does.
    const ws = new Xano()
      .registerWorkspace({ name: "w" })
      .registerTables([table({ name: "u", idType: "uuid", schema: { email: f.email() } })]);
    const bundle = ws.export() as unknown as { payload: { dbo: Array<Record<string, unknown>> } };
    const id = (bundle.payload.dbo[0]!.schema as Array<Record<string, unknown>>).find(
      (c) => c.name === "id",
    )!;
    expect(Object.hasOwn(id, "default")).toBe(false);

    const project = decodeBundle(bundle as never);
    // No fallback: the column comes back as a readable catalog call, not a
    // descriptor literal or a rawField() passthrough.
    expect(project.report.renderCli()).toBe("");
    const emitted = project.files.find((x) => x.path === "table/u.ts")!.contents;
    expect(emitted).toContain("noDefault: true");
    expect(emitted).not.toContain("rawField");
  });

  it("rejects `noDefault` together with `default`", () => {
    // On a type where `default` is otherwise legal, so this guard is what fires.
    expect(() => f.text({ noDefault: true, default: "x" })).toThrow(/mutually exclusive/);
  });
});
