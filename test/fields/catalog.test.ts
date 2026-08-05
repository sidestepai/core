import { describe, it, expect } from "vitest";
import { f } from "../../src/fields/catalog.js";
import { encodeTable, encodeColumn, table } from "../../src/kinds/table.js";
import type { TableDef } from "../../src/kinds/table.js";
import { col, c } from "../../src/values/value.js";
import { expr } from "../../src/statements/conditional.js";
import { normalize, loadFixture } from "../conformance/harness.js";
import { deriveGuid, resolveRef } from "../../src/refs/guid.js";

/** The id + created_at meta columns the engine always persists at the head of a schema. */
const meta = {
  id: f.int({ required: true }),
  created_at: f.timestamp({ default: "now", access: "private" }),
};

/** Standard 3-index set in the basic fixtures (primary / gin / btree). */
const baseIndex: TableDef["index"] = [
  { type: "primary", fields: [{ name: "id" }] },
  { type: "gin", fields: [{ name: "xdo", op: "jsonb_path_op" }] },
  { type: "btree", fields: [{ name: "created_at", op: "desc" }] },
];

describe("f.* field-type catalog — authoring→stored type mapping", () => {
  it("maps the six renamed types to their stored names", () => {
    expect(f.timestamp().type).toBe("epochms");
    expect(f.image().type).toBe("blob_img");
    expect(f.video().type).toBe("blob_video");
    expect(f.audio().type).toBe("blob_audio");
    expect(f.attachment().type).toBe("blob");
    expect(f.object({}).type).toBe("obj");
  });

  it("keeps identity types unchanged", () => {
    expect(f.text().type).toBe("text");
    expect(f.geo.multipolygon().type).toBe("geo_multipolygon");
    expect(f.uuid().type).toBe("uuid");
  });

  it("validates positional payloads", () => {
    expect(() => f.vector(0)).toThrow(/integer >= 1/);
    expect(() => f.int({ format: "markdown" })).toThrow(/format.*only valid on text/);
  });

  it("accepts an enum with no values, because the engine stores one", () => {
    // An enum column added in the editor and not yet given its options. One
    // table in the survey corpus has exactly this, and refusing it made the SDK
    // stricter than the engine — the column came back as a descriptor literal
    // with a warning saying the constructor threw.
    expect(f.enum([]).options).toMatchObject({ values: [] });
    // The paired positive: a populated enum is unchanged.
    expect(f.enum(["a", "b"]).options).toMatchObject({ values: ["a", "b"] });
  });

  it("guards `default` to types the engine actually persists it on", () => {
    expect(() => f.uuid({ default: "x" })).toThrow(/default.*not supported on "uuid"/);
    expect(() => f.object({}, { default: "x" })).toThrow(/default.*not supported on "obj"/);
    // Allowed types (incl. timestamp→epochms) and an empty default are fine.
    expect(() => f.int({ default: "0" })).not.toThrow();
    expect(() => f.timestamp({ default: "now" })).not.toThrow();
    expect(() => f.uuid({ default: "" })).not.toThrow();
  });

  it("guards `access` and text `format` to the engine's enums", () => {
    // Closed unions reject these at compile time; the runtime guard is the
    // belt-and-suspenders for plain-JS callers (and what these asserts cover).
    // @ts-expect-error "secret" is not a FieldAccess
    expect(() => f.text({ access: "secret" })).toThrow(/invalid `access`/);
    // @ts-expect-error "json" is not a TextFormat
    expect(() => f.text({ format: "json" })).toThrow(/invalid text `format`/);
    expect(() => f.text({ access: "internal", format: "markdown" })).not.toThrow();
    expect(() => f.password()).not.toThrow(); // defaults access:"internal"
  });
});

describe("rich table schemas — byte-exact vs golden corpus", () => {
  it("table-all: every scalar/geo/file type + per-field modifiers", () => {
    const t = encodeTable({
      name: "example",
      schema: {
        ...meta,
        name: f.text({ methods: ["trim"] }),
        image: f.image({ nullable: true }),
        vid: f.video({ nullable: true }),
        music: f.audio({ nullable: true }),
        attach: f.attachment({ nullable: true }),
        pt: f.geo.point({ nullable: true }),
        pts: f.geo.multipoint({ nullable: true }),
        path: f.geo.linestring({ nullable: true }),
        paths: f.geo.multilinestring({ nullable: true }),
        poly: f.geo.polygon(),
        polys: f.geo.multipolygon({ nullable: true }),
        email: f.email({ methods: ["trim", "lower"] }),
        pass: f.password({ sensitive: true }),
        js: f.json(),
        superid: f.uuid({ nullable: true }),
      },
      index: baseIndex,
    });
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-all.json")));
  });

  it("table-fancy: required/nullable/default/combo text modifiers", () => {
    const t = encodeTable({
      name: "fancy",
      schema: {
        ...meta,
        name: f.text({ methods: ["trim"] }),
        name_required: f.text({ required: true, methods: ["trim"] }),
        name_nullable: f.text({ nullable: true, methods: ["trim"] }),
        name_default: f.text({ default: "test123", methods: ["trim"] }),
        name_combo: f.text({ required: true, nullable: true, default: "test", methods: ["trim"] }),
      },
      index: baseIndex,
    });
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-fancy.json")));
  });

  it("table-fancy2: array column (int[]) + description", () => {
    const t = encodeTable({
      name: "fancy",
      schema: {
        ...meta,
        name: f.text({ methods: ["trim"] }),
        name_required: f.text({ required: true, methods: ["trim"] }),
        name_nullable: f.text({ nullable: true, methods: ["trim"] }),
        name_default: f.text({ default: "test123", methods: ["trim"] }),
        name_combo: f.text({ required: true, nullable: true, default: "test", methods: ["trim"] }),
        scores: f.int({ array: true, description: "wow" }),
      },
      index: baseIndex,
    });
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-fancy2.json")));
  });

  it("table-sensitive: sensitive flag + trim method", () => {
    const t = encodeTable({
      name: "xs1a",
      schema: { ...meta, secret: f.text({ sensitive: true, methods: ["trim"] }) },
      index: baseIndex,
    });
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-sensitive.json")));
  });
});

describe("system-column auto-injection", () => {
  it("auto-prepends id + created_at when absent (byte-exact vs fixture)", () => {
    // Same as table-sensitive but WITHOUT the explicit `...meta` head.
    const t = encodeTable({
      name: "xs1a",
      schema: { secret: f.text({ sensitive: true, methods: ["trim"] }) },
      index: baseIndex,
    });
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-sensitive.json")));
  });

  it("does not duplicate system columns the author declares (explicit ...meta still byte-exact)", () => {
    const t = encodeTable({
      name: "xs1a",
      schema: { ...meta, secret: f.text({ sensitive: true, methods: ["trim"] }) },
      index: baseIndex,
    });
    const names = t.schema.map((col) => col.name);
    expect(names).toEqual(["id", "created_at", "secret"]);
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-sensitive.json")));
  });

  it("injects only the missing system column", () => {
    // Author declares created_at but not id → id is prepended, created_at kept in place.
    const names = encodeTable({
      name: "t",
      schema: { created_at: f.timestamp({ default: "now", access: "private" }), x: f.text() },
    }).schema.map((col) => col.name);
    expect(names).toEqual(["id", "created_at", "x"]);
  });

  it("system:false leaves the schema untouched", () => {
    const names = encodeTable({
      name: "raw",
      schema: { only: f.text() },
      system: false,
    }).schema.map((col) => col.name);
    expect(names).toEqual(["only"]);
  });
});

describe("table-reference (foreign-key) fields", () => {
  it("emits the trailing @ method carrying the target table's guid", () => {
    const guid = resolveRef("dbo", "author");
    const col = encodeColumn({ name: "author_id", type: "int", ...f.tableRef("author").options });
    expect(col.type).toBe("int");
    expect(col.methods).toContainEqual({ name: "@", disabled: false, arg: [`dbo=${guid}`] });
  });

  it("appends @ after authored validator methods", () => {
    const d = f.tableRef("author", { methods: ["min:1"] });
    expect(d.options.methods).toEqual([
      "min:1",
      { name: "@", arg: [`dbo=${resolveRef("dbo", "author")}`] },
    ]);
  });

  it("references resolve to the target table's payload guid (round-trip)", () => {
    const author = encodeTable({ name: "author", schema: { handle: f.text() } });
    const guid = deriveGuid("dbo", "author");
    // The table object emits this guid; the reference computes the identical one.
    const book = encodeTable({
      name: "book",
      schema: { title: f.text(), author_id: f.tableRef(author) },
    });
    const ref = book.schema.find((c) => c.name === "author_id")!;
    expect(ref.methods).toContainEqual({ name: "@", disabled: false, arg: [`dbo=${guid}`] });
    // `author` def handle has no explicit guid, so the table's *export* guid is
    // derived the same way db statements resolve it.
    expect(resolveRef("dbo", "author")).toBe(guid);
    void author;
  });

  it("supports uuid-keyed references", () => {
    expect(f.tableRef("org", { type: "uuid" }).type).toBe("uuid");
  });

  it("rejects a reference whose type contradicts the target's primary key", () => {
    // The engine requires the two to match and fails the IMPORT otherwise, which
    // is the slowest possible place to learn it. A def handle carries `idType`,
    // so both directions are catchable at authoring time.
    const orgs = table({ name: "orgs", idType: "uuid", schema: { title: f.text() } });
    const posts = table({ name: "posts", schema: { title: f.text() } });
    expect(() => f.tableRef(orgs)).toThrow(/primary key is "uuid"/);
    expect(() => f.tableRef(posts, { type: "uuid" })).toThrow(/primary key is "int"/);
    // …and the matching pairs stay silent, including the int default.
    expect(f.tableRef(orgs, { type: "uuid" }).type).toBe("uuid");
    expect(f.tableRef(posts).type).toBe("int");
  });

  it("leaves a BARE-NAME reference unchecked — there is no schema to check against", () => {
    // The self-reference spelling. Guessing a key type here would reject valid
    // authoring; the engine still catches a real mismatch at import.
    expect(() => f.tableRef("orgs")).not.toThrow();
    expect(() => f.tableRef("orgs", { type: "uuid" })).not.toThrow();
  });
});

describe("system-index auto-injection", () => {
  it("auto-prepends the standard primary/gin/btree triple when index is omitted", () => {
    // Same as table-sensitive but WITHOUT the explicit baseIndex.
    const t = encodeTable({
      name: "xs1a",
      schema: { ...meta, secret: f.text({ sensitive: true, methods: ["trim"] }) },
    });
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-sensitive.json")));
  });

  it("does not duplicate an author-declared standard index", () => {
    const t = encodeTable({
      name: "xs1a",
      schema: { ...meta, secret: f.text({ sensitive: true, methods: ["trim"] }) },
      index: baseIndex,
    });
    expect(t.index.map((i) => i.type)).toEqual(["primary", "gin", "btree"]);
  });

  it("prepends the standard set ahead of a custom index", () => {
    const types = encodeTable({
      name: "u",
      schema: { ...meta, email: f.email() },
      index: [{ type: "btree|unique", fields: [{ name: "email", op: "asc" }] }],
    }).index.map((i) => i.type);
    // No gin by default — it rides along only when `useXdo` is set.
    expect(types).toEqual(["primary", "btree", "btree|unique"]);
  });

  it("includes gin ahead of a custom index when useXdo is set", () => {
    const types = encodeTable({
      name: "u",
      schema: { ...meta, email: f.email() },
      useXdo: true,
      index: [{ type: "btree|unique", fields: [{ name: "email", op: "asc" }] }],
    }).index.map((i) => i.type);
    expect(types).toEqual(["primary", "gin", "btree", "btree|unique"]);
  });

  it("system:false leaves indexes untouched", () => {
    const idx = encodeTable({
      name: "raw",
      schema: { only: f.text() },
      system: false,
    }).index;
    expect(idx).toEqual([]);
  });
});

describe("filter methods with arguments", () => {
  it("parses colon-form filter args, recovering numbers (min:10 → arg:[10])", () => {
    // A numeric arg encodes as a NUMBER, matching what the engine persists for a
    // UI-authored rule (`min` on a password column stores `arg: [8]`). The colon
    // form previously stringified it, which made `"min:10"` and the equivalent
    // `{name:"min", arg:[10]}` encode to different bytes.
    const score = encodeColumn({ name: "score", type: "int", methods: ["min:10"] });
    expect(score.methods).toEqual([{ name: "min", disabled: false, arg: [10] }]);
  });

  it("keeps a genuinely-textual arg a string", () => {
    const slug = encodeColumn({ name: "slug", type: "text", methods: [{ name: "min", arg: ["10"] }] });
    expect(slug.methods).toEqual([{ name: "min", disabled: false, arg: ["10"] }]);
  });
});

describe("table views — byte-exact vs golden corpus", () => {
  it("table-view: expression + sort + hiddenCols + alias + id", () => {
    const t = encodeTable({
      name: "user",
      auth: true,
      schema: {
        ...meta,
        email: f.email({ required: true, nullable: true, methods: ["trim", "lower"] }),
        password: f.password({
          required: true,
          nullable: true,
          methods: ["min:8", "minAlpha:1", "minDigit:1"],
        }),
        score: f.int({ methods: ["min:10"] }),
      },
      index: [
        { type: "primary", fields: [{ name: "id" }] },
        { type: "btree", fields: [{ name: "created_at", op: "desc" }] },
        { type: "gin", fields: [{ name: "xdo", op: "jsonb_path_op" }] },
        { type: "btree|unique", fields: [{ name: "email", op: "asc" }] },
      ],
      views: [
        {
          name: "dude",
          alias: "dude101",
          id: "f4e1c6de-0233-4a0c-8a54-809a4bacae91",
          hide: ["password"],
          where: expr(col("email"), "=", c.text("sean@xano.com")),
          sort: [{ name: "id", order: "desc" }],
        },
      ],
    });
    expect(normalize(t)).toEqual(normalize(loadFixture("tables/schema-table-view.json")));
  });
});
