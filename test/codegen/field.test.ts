/**
 * U7 — field, input, and response decoders.
 *
 * `test/fixtures/fields/` holds exactly one file, so a per-field-type *golden*
 * comparison does not exist. The per-type material that does exist is authoring
 * source, so field-type coverage is driven as an encode→decode→encode identity
 * check over the real catalog: build a field with `f.*`, encode it, decode it
 * back to source, evaluate that source, and re-encode. Golden comparison is
 * scoped to the 8 table fixtures plus `enum-action.json`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FieldXdo } from "../../src/types/xdo.js";
import { normalize } from "../../src/validate/normalize.js";
import { COLUMN_CONTEXT, INPUT_CONTEXT, encodeField } from "../../src/fields/field.js";
import { f } from "../../src/fields/catalog.js";
import type { FieldDescriptor } from "../../src/fields/catalog.js";
import { input } from "../../src/inputs/input.js";
import { encodeResponse } from "../../src/responses/response.js";
import { c, ref, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { rawValue } from "../../src/values/raw-value.js";
import { rawResponse } from "../../src/responses/raw-response.js";
import type { ResultItemXdo } from "../../src/types/xdo.js";
import { rawField } from "../../src/fields/raw-field.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeField, decodeFieldMap, decodeResponse } from "../../src/codegen/field.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const readFixture = (rel: string) => JSON.parse(readFileSync(FIXTURES + rel, "utf8")) as never;

/** An index over a payload containing the tables the field examples reference. */
function refsFor(payload: Record<string, unknown> = {}): RefIndex {
  return RefIndex.fromPayload(payload, new DecodeContext());
}

/** Evaluate emitted field source against the real catalog. */
function evaluate(source: string): FieldDescriptor {
  const fn = new Function(
    "f", "input", "rawValue", "rawField", "c", "ref", "withFilters", "fl",
    `return (${source});`,
  );
  return fn(f, input, rawValue, rawField, c, ref, withFilters, fl) as FieldDescriptor;
}

/**
 * Encode a descriptor, decode it back to source, evaluate, re-encode — and
 * assert the two stored forms are identical. Returns the emitted source.
 */
function identity(
  name: string,
  descriptor: FieldDescriptor,
  surface: "f" | "input" = "f",
  refs = refsFor(),
): string {
  const context = surface === "input" ? INPUT_CONTEXT : COLUMN_CONTEXT;
  const stored = encodeField(name, descriptor.type, descriptor.options, context);
  const ctx = new DecodeContext();
  const source = printExpr(decodeField(ctx, refs, stored, surface).expr);
  const back = evaluate(source);
  expect(encodeField(name, back.type, back.options, context), `source: ${source}`).toEqual(stored);
  return source;
}

/** Every catalog field type, mirroring `examples/sandbox/fields/`. */
const CATALOG_CASES: Array<[string, FieldDescriptor]> = [
  ["text", f.text()],
  ["text_opts", f.text({ required: true, nullable: true, default: "hi", format: "markdown" })],
  ["int", f.int({ default: 0 })],
  ["decimal", f.decimal()],
  ["bool", f.bool({ default: false })],
  ["uuid", f.uuid()],
  ["date", f.date()],
  ["email", f.email({ required: true })],
  ["password", f.password()],
  ["json", f.json()],
  ["timestamp", f.timestamp({ default: "now" })],
  ["image", f.image()],
  ["video", f.video()],
  ["audio", f.audio()],
  ["attachment", f.attachment()],
  ["geo_point", f.geo.point()],
  ["geo_multipoint", f.geo.multipoint()],
  ["geo_linestring", f.geo.linestring()],
  ["geo_multilinestring", f.geo.multilinestring()],
  ["geo_polygon", f.geo.polygon()],
  ["geo_multipolygon", f.geo.multipolygon()],
  ["enum", f.enum(["draft", "live"])],
  ["vector", f.vector(1536)],
  ["object", f.object({ street: f.text(), zip: f.int() })],
  ["list", f.text({ array: true })],
  ["sensitive", f.text({ sensitive: true, access: "private" })],
  ["methods", f.text({ methods: ["trim", "min:6"] })],
  ["described", f.text({ description: "a note" })],
];

describe("decodeField — catalog coverage", () => {
  // Table-driven over the catalog, so a field type added without a decoder
  // branch fails here rather than degrading silently on a real workspace.
  it.each(CATALOG_CASES)("round-trips f.%s identically", (name, descriptor) => {
    identity(name, descriptor);
  });

  it("emits the idiomatic catalog call for each mapped type", () => {
    expect(identity("a", f.text())).toBe("f.text()");
    expect(identity("b", f.timestamp())).toBe("f.timestamp()");
    expect(identity("c", f.image())).toBe("f.image()");
    expect(identity("d", f.geo.polygon())).toBe("f.geo.polygon()");
    expect(identity("e", f.email({ required: true }))).toBe("f.email({\n  required: true,\n})");
  });

  it("keeps a field's methods in order", () => {
    const source = identity("m", f.text({ methods: ["trim", "lower", "min:6"] }));
    expect(source.indexOf("trim")).toBeLessThan(source.indexOf("lower"));
    expect(source.indexOf("lower")).toBeLessThan(source.indexOf("min"));
  });

  it("decodes a nested object field recursively", () => {
    const source = identity("addr", f.object({ street: f.text(), meta: f.object({ zip: f.int() }) }));
    expect(source).toContain("f.object(");
    expect(source).toContain("street: f.text()");
    expect(source).toContain("zip: f.int()");
  });

  it("omits f.password's built-in access default but keeps an overridden one", () => {
    expect(identity("p", f.password())).toBe("f.password()");
    expect(identity("p", f.password({ access: "public" }))).toContain("access");
  });

  it("resolves an f.tableRef target to a symbol rather than a raw guid", () => {
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    const stored = encodeField(
      "author_id",
      "int",
      { methods: [{ name: "@", arg: [`dbo=${guid}`] }] },
      COLUMN_CONTEXT,
    );
    const ctx = new DecodeContext();
    const source = printExpr(
      decodeField(ctx, refs, stored, "f", { symbolFor: (t) => t.name }).expr,
    );
    expect(source).toBe("f.tableRef(users)");
    expect(source).not.toContain(guid);
  });

  it("keeps a uuid-keyed tableRef's type option", () => {
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    const stored = encodeField(
      "author_id",
      "uuid",
      { methods: [{ name: "@", arg: [`dbo=${guid}`] }] },
      COLUMN_CONTEXT,
    );
    const ctx = new DecodeContext();
    expect(printExpr(decodeField(ctx, refs, stored, "f", { symbolFor: (t) => t.name }).expr)).toBe(
      ['f.tableRef(users, {', '  type: "uuid",', '})'].join("\n"),
    );
  });

  it("decodes an FK annotation whose target was cleared as an ordinary column", () => {
    // The editor writes a bare `dbo=` when a reference is cleared. It is not a
    // reference, and reading it as one made `f.tableRef` throw on an empty
    // target and take the whole field down to a descriptor literal — 50 columns
    // across the sweep. The `@` method rides along in `methods` instead.
    const stored = encodeField("author_id", "int", { methods: [{ name: "@", arg: ["dbo="] }] }, COLUMN_CONTEXT);
    const ctx = new DecodeContext();
    const decoded = decodeField(ctx, refsFor(), stored, "f");
    expect(decoded.idiomatic).toBe(true);
    const source = printExpr(decoded.expr);
    expect(source).toContain("f.int(");
    expect(source).not.toContain("tableRef");
    const back = evaluate(source);
    expect(encodeField("author_id", back.type, back.options, COLUMN_CONTEXT)).toEqual(stored);
    expect(ctx.report.entries).toHaveLength(0);
  });

  it("falls back to a descriptor literal for a type outside the catalog", () => {
    const stored = encodeField("weird", "some_future_type", { required: true }, COLUMN_CONTEXT);
    const ctx = new DecodeContext();
    const decoded = decodeField(ctx, refsFor(), stored, "f");
    expect(decoded.idiomatic).toBe(false);
    const back = evaluate(printExpr(decoded.expr));
    expect(encodeField("weird", back.type, back.options, COLUMN_CONTEXT)).toEqual(stored);
    expect(ctx.report.entries[0]!.category).toBe("value-fallback");
  });

  it("preserves a stored key no authoring surface can produce, via rawField", () => {
    // `override` is encoder-fixed with no authoring option, so a field that sets it
    // cannot come back as any catalog call or descriptor — it rides through
    // `rawField()` byte-for-byte and is reported by name (R9).
    const stored = { ...encodeField("x", "text", {}, COLUMN_CONTEXT), override: ["x"] };
    const ctx = new DecodeContext();
    const decoded = decodeField(ctx, refsFor(), stored, "f");
    const source = printExpr(decoded.expr);
    expect(source).toContain("rawField(");
    const back = evaluate(source);
    expect(encodeField("x", back.type, back.options, COLUMN_CONTEXT)).toEqual(stored);
    expect(ctx.report.entries[0]!.detail).toContain("override");
  });

  it("recovers merge and hidden as a readable catalog call, not rawField", () => {
    // These two were encoder-fixed, and together they were the largest single cause
    // of `rawField()` in the 187-workspace sweep — 584 fields carry `merge: true`
    // with a `hidden` list beside it. They are authorable options now, so the field
    // comes back readable AND byte-identical.
    for (const hidden of [["created_at"], [""], ["created_at", "updated_at"]]) {
      const stored = { ...encodeField("x", "text", {}, COLUMN_CONTEXT), merge: true, hidden };
      const ctx = new DecodeContext();
      const source = printExpr(decodeField(ctx, refsFor(), stored, "f").expr);
      expect(source).not.toContain("rawField(");
      expect(source).toContain("merge: true");
      const back = evaluate(source);
      // Byte-identical, including a `[""]` entry — reproduced verbatim rather than
      // interpreted, so nothing depends on what an empty entry MEANS.
      expect(encodeField("x", back.type, back.options, COLUMN_CONTEXT)).toEqual(stored);
      expect(ctx.report.entries).toEqual([]);
    }
  });

  /**
   * A field's `list` block is its array length bounds, and the engine does not
   * spell "unset" consistently: 8,814 fields in the sweep store `{min:"",max:""}`
   * and two store `{min:{},max:{}}`. Both mean unbounded.
   *
   * Comparing against the first spelling alone emitted `list: {max: {}, min: {}}`
   * into a real pulled tool — bytes no author would write, and ill-typed besides,
   * since `FieldOptions.list` declares strings. So the tree did not compile.
   */
  const BLANK_LIST_BOUNDS: ReadonlyArray<readonly [label: string, bounds: unknown]> = [
    ["empty strings (8,814 fields)", { min: "", max: "" }],
    ["empty objects (2 fields)", { min: {}, max: {} }],
    ["mixed spellings", { min: "", max: {} }],
  ];

  it.each(BLANK_LIST_BOUNDS)("elides an unbounded list spelled with %s", (_label, bounds) => {
    const stored = { ...encodeField("x", "text", { array: true }, COLUMN_CONTEXT), list: bounds };
    const ctx = new DecodeContext();
    const source = printExpr(decodeField(ctx, refsFor(), stored as FieldXdo, "f").expr);
    expect(source).not.toContain("rawField(");
    expect(source).not.toContain("list:");
    // The elision is only safe because `normalize` calls the two spellings equal,
    // so the re-encode still verifies against the bytes that were pulled.
    const back = evaluate(source);
    expect(normalize(encodeField("x", back.type, back.options, COLUMN_CONTEXT))).toEqual(
      normalize(stored),
    );
    expect(ctx.report.entries).toEqual([]);
  });

  it("keeps a list bound that is actually set", () => {
    // The paired negative: the elision is about blankness, not about the key.
    const stored = {
      ...encodeField("x", "text", { array: true }, COLUMN_CONTEXT),
      list: { min: "1", max: "" },
    } as FieldXdo;
    const source = printExpr(decodeField(new DecodeContext(), refsFor(), stored, "f").expr);
    expect(source).toContain('min: "1"');
    const back = evaluate(source);
    expect(encodeField("x", back.type, back.options, COLUMN_CONTEXT)).toEqual(stored);
  });

  /**
   * The six field-flag combinations the 187-workspace sweep actually found, with
   * the row counts it measured. Together they are 1,782 of the 1,885 `rawField()`
   * envelopes sampled — C8, which the plan had recorded as the largest single
   * cluster and a field-authoring design question.
   *
   * Kept table-driven against real counts so a regression here is legible as "this
   * many real fields just lost their readable form", not as one abstract case.
   */
  const SWEPT_FLAGS: ReadonlyArray<readonly [label: string, rows: number, flags: Record<string, unknown>]> = [
    ["customize as an empty array", 842, { customize: [] }],
    ["merge with a hidden list", 584, { merge: true, hidden: ["created_at"] }],
    ["hidden holding an empty name", 214, { hidden: [""] }],
    ["all three together", 109, { merge: true, hidden: ["created_at"], customize: [] }],
    ["hidden holding a numeric-looking name", 23, { hidden: ["1"] }],
    ["merge alone", 10, { merge: true }],
  ];

  it.each(SWEPT_FLAGS)(
    "decodes %s (%i real fields) readably and byte-identically",
    (_label, _rows, flags) => {
      const stored = { ...encodeField("x", "text", {}, COLUMN_CONTEXT), ...flags } as FieldXdo;
      const ctx = new DecodeContext();
      const source = printExpr(decodeField(ctx, refsFor(), stored, "f").expr);
      expect(source).not.toContain("rawField(");
      const back = evaluate(source);
      // Compared under `normalize`, the comparator the round-trip contract itself
      // uses: an empty `customize` canonicalizes forward to the `{}` the SDK writes,
      // the same accepted artifact as `mocks` and an empty `context`.
      expect(normalize(encodeField("x", back.type, back.options, COLUMN_CONTEXT)), source).toEqual(
        normalize(stored),
      );
    },
  );

  it("leaves an unmerged, unhidden field's source untouched", () => {
    // The paired negative: the two new options must not appear on the fields that
    // do not set them, which is nearly all of them.
    const stored = encodeField("x", "text", {}, COLUMN_CONTEXT);
    const source = printExpr(decodeField(new DecodeContext(), refsFor(), stored, "f").expr);
    expect(source).not.toContain("merge");
    expect(source).not.toContain("hidden");
  });

  it("reports a disabled method instead of dropping it", () => {
    const stored: FieldXdo = {
      ...encodeField("x", "text", {}, COLUMN_CONTEXT),
      methods: [{ name: "trim", disabled: true, arg: [] }],
    };
    const ctx = new DecodeContext();
    expect(decodeField(ctx, refsFor(), stored, "f").idiomatic).toBe(false);
  });
});

describe("decodeField — inputs", () => {
  it.each([
    ["text", input.text()],
    ["int", input.int()],
    ["enum", input.enum(["a", "b"])],
    ["object", input.object({ id: f.int() })],
    ["list", input.list(input.text())],
    ["required", input.text({ required: true, description: "who" })],
    ["file", input.file()],
  ] as Array<[string, FieldDescriptor]>)("round-trips input.%s identically", (name, descriptor) => {
    identity(name, descriptor, "input");
  });

  it("decodes a raw file upload to input.file()", () => {
    // A stored `file` is the request's bytes, not a stored file resource. It had
    // no catalog form at all, so every upload input in the sweep came back as a
    // descriptor literal.
    expect(identity("avatar", input.file(), "input")).toBe("input.file()");
  });

  it("decodes a database link to input.dbLink, resolving the table to its symbol", () => {
    // 718 fields across the sweep, every one of them `merge: true` — the flag
    // that makes the engine EXPAND the link into one input per column. The type
    // is the table's identity with `_mvpschema` appended, so it is a reference
    // and must resolve to the table's symbol rather than a raw guid.
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    const stored = encodeField(
      "users__",
      `${guid}_mvpschema`,
      { merge: true, hidden: ["created_at"] },
      INPUT_CONTEXT,
    );
    const ctx = new DecodeContext();
    const decoded = decodeField(ctx, refs, stored, "input", { symbolFor: (t) => t.name });
    expect(decoded.idiomatic).toBe(true);
    const source = printExpr(decoded.expr);
    expect(source).toContain("input.dbLink(users");
    expect(source).toContain("created_at");
    // `merge` is forced by the constructor, so echoing it back would be noise.
    expect(source).not.toContain("merge");
    expect(source).not.toContain(guid);
    expect(ctx.report.entries).toHaveLength(0);
  });

  it("round-trips a database link byte-for-byte", () => {
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    identity("users__", input.dbLink({ name: "users", guid }, { hidden: ["created_at"] }), "input", refs);
  });

  it("clears a customize table reference stored as a LOCAL row id, and says so", () => {
    // An old engine version did not remap `@` targets inside `customize` to
    // portable guids the way it does everywhere else, so a legacy workspace can
    // hold `dbo=14`. An internal row id is not identity, so it is recovered as
    // unbound rather than carried somewhere it would name a different table.
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const stored = {
      ...encodeField("users__", `${guid}_mvpschema`, { merge: true }, INPUT_CONTEXT),
      customize: {
        owner_id: { hidden: false, default: "", required: false, customize: [], methods: [{ name: "@", arg: ["dbo=14"] }] },
      },
    };
    const ctx = new DecodeContext();
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    const decoded = decodeField(ctx, refs, stored as never, "input");
    const source = printExpr(decoded.expr);
    // Reset to the unbound spelling, not carried — on the READABLE path, which
    // is where a customized dblink lands now.
    expect(source).toContain("input.dbLink(");
    // The `@` target survives, pointing at nothing — in the explicit `{name, arg}`
    // form, not the colon shorthand. No field type's method union enumerates `@`,
    // so `"@:dbo="` did not type-check and the whole generated tree failed to
    // compile; the object form is what `MethodArg` carries for exactly this.
    expect(source).toContain('name: "@"');
    expect(source).toContain('"dbo="');
    expect(source).not.toContain('"@:dbo="');
    expect(source).not.toContain("dbo=14");
    // Warned about by name — a cleared reference is a real loss, not a passthrough.
    const detail = ctx.report.entries.map((e) => String(e.detail)).join(" | ");
    expect(detail).toContain("dbo=14");
    expect(detail).toContain("LOCAL row id");
    expect(ctx.report.entries.some((e) => e.category === "unportable-id")).toBe(true);
  });

  it("leaves a guid-form customize reference alone", () => {
    // Only the LOCAL spelling is unportable. A real guid is identity and stays.
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const target = "1111000000000000000000000000aaaa";
    const stored = {
      ...encodeField("users__", `${guid}_mvpschema`, { merge: true }, INPUT_CONTEXT),
      customize: {
        owner_id: { hidden: false, default: "", required: false, customize: [], methods: [{ name: "@", arg: [`dbo=${target}`] }] },
      },
    };
    const ctx = new DecodeContext();
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    const decoded = decodeField(ctx, refs, stored as never, "input");
    expect(printExpr(decoded.expr)).toContain(target);
    expect(ctx.report.entries.some((e) => e.category === "unportable-id")).toBe(false);
  });

  it("recovers a per-column customize map as a readable dbLink call", () => {
    // Xano's own CRUD scaffold writes this: one dblink input whose expansion is
    // customized per column. It was the largest `rawField()` cluster in the
    // sweep — 77 fields — until `customize` became an authorable option.
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    const source = identity(
      "users__",
      input.dbLink(
        { name: "users", guid },
        {
          hidden: ["created_at"],
          customize: {
            first_name: { required: true, methods: ["lower", "trim"] },
            bio: { default: "n/a" },
            secret: { hidden: true },
            address: { customize: { zip: { required: true } } },
          },
        },
      ),
      "input",
      refs,
    );
    expect(source).toContain("input.dbLink(");
    expect(source).toContain("customize");
    expect(source).not.toContain("rawField(");
  });

  it("carries a customize node with an unmodelled member verbatim", () => {
    // Every node in the survey corpus holds the same five keys. A sixth is a
    // shape this has never seen, so it must not be encoded as though the extra
    // member were absent — that would be a silent rewrite of stored bytes.
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const stored = {
      ...encodeField("users__", `${guid}_mvpschema`, { merge: true }, INPUT_CONTEXT),
      customize: {
        bio: { hidden: false, default: "", required: false, customize: {}, methods: [], sensitive: true },
      },
    };
    const ctx = new DecodeContext();
    const refs = refsFor({ dbo: [{ name: "users", guid }] });
    const source = printExpr(decodeField(ctx, refs, stored as never, "input").expr);
    expect(source).toContain("rawField(");
    expect(source).toContain("sensitive");
  });

  it("keeps the database link off the column surface", () => {
    // `excludedTypesForDatabase` rules dblink out as a column: a column linking a
    // whole table is a foreign key, which is f.tableRef.
    const guid = "9f3c81a04be27d6510aa4c8831ef25b7";
    const stored = encodeField("users__", `${guid}_mvpschema`, { merge: true }, COLUMN_CONTEXT);
    const ctx = new DecodeContext();
    const decoded = decodeField(ctx, refsFor({ dbo: [{ name: "users", guid }] }), stored, "f");
    expect(printExpr(decoded.expr)).not.toContain("dbLink");
  });

  it("keeps the upload type off the column surface", () => {
    // There is no `f.file`: a table holds a stored resource, never an upload.
    // Resolving `file` against `f` would emit source that does not evaluate.
    expect((f as Record<string, unknown>)["file"]).toBeUndefined();
    const stored = encodeField("avatar", "file", {}, COLUMN_CONTEXT);
    const ctx = new DecodeContext();
    const decoded = decodeField(ctx, refsFor(), stored, "f");
    expect(decoded.idiomatic).toBe(false);
    expect(printExpr(decoded.expr)).not.toContain("f.file");
  });

  it("emits against the input catalog, not the field catalog", () => {
    expect(identity("q", input.text(), "input")).toBe("input.text()");
  });

  it("does not re-hash or re-author an input.password's bound value", () => {
    // The hashing happens at bind time in the engine, not in the stored shape —
    // so nothing hash-like should appear as an authored default here.
    const source = identity("pw", input.password(), "input");
    expect(source).toBe("input.password()");
    expect(source).not.toContain("default");
  });

  it("emits the minimal descriptor for an input matching encoder defaults", () => {
    expect(identity("plain", input.text(), "input")).toBe("input.text()");
  });

  it("decodes a whole input map keyed by name", () => {
    const stored = [
      encodeField("email", "email", { required: true }, INPUT_CONTEXT),
      encodeField("age", "int", {}, INPUT_CONTEXT),
    ];
    const ctx = new DecodeContext();
    ctx.beginFile();
    const source = printExpr(decodeFieldMap(ctx, refsFor(), stored, "input"));
    expect(source).toContain("email: input.email({");
    expect(source).toContain("age: input.int()");
  });
});

describe("decodeField — golden fixtures", () => {
  it("decodes a legacy `customize:\"\"` field to a catalog call, canonicalizing it", () => {
    // `enum-action.json` is older-vintage like several table columns: it stores
    // `customize: ""` where the current engine and this SDK write `{}`. The two
    // are the same empty customization, so the field decodes to a readable
    // catalog call and re-exports the CURRENT form — `""` is a shape this SDK
    // reads and never writes.
    const stored = readFixture("fields/enum-action.json") as FieldXdo;
    expect(stored.customize).toBe("");
    const ctx = new DecodeContext();
    const source = printExpr(decodeField(ctx, refsFor(), stored, "f").expr);
    expect(source).not.toContain("rawField(");
    const back = evaluate(source);
    const reencoded = encodeField(stored.name, back.type, back.options, COLUMN_CONTEXT);
    expect(reencoded.customize).toEqual({});
    expect(normalize(reencoded)).toEqual(normalize(stored));
    expect(ctx.report.entries).toEqual([]);
  });

  const TABLE_FIXTURES = [
    "ex_field_table_ref.json",
    "ex_kind_products.json",
    "schema-table-all.json",
    "schema-table-fancy.json",
    "schema-table-fancy2.json",
    "schema-table-sensitive.json",
    "schema-table-view.json",
    "schema-table.json",
  ];

  /**
   * Every column round-trips, compared under `normalize` — the round-trip
   * contract's own comparator, and the one both `sidestep validate` and codegen
   * verification use.
   *
   * Deliberately not raw byte equality. Several fixture columns predate the
   * current field encoder and store `customize: ""` (plus an empty `_xsid`)
   * where the engine and this SDK now write `{}`. Those are the same field, and
   * asserting bytes here meant asserting that the decoder must preserve a shape
   * it is not allowed to emit — which forced every such column through
   * `rawField()`. Canonicalizing forward is the policy; this is the assertion
   * that matches it.
   */
  it.each(TABLE_FIXTURES)("round-trips every column in %s", (file) => {
    const table = readFixture(`tables/${file}`) as { schema?: FieldXdo[] };
    const columns = table.schema ?? [];
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      const ctx = new DecodeContext();
      // Table refs resolve through the index; with no bundle here they degrade to
      // a {name, guid} literal, which still re-encodes to the same stored method.
      const back = evaluate(printExpr(decodeField(ctx, refsFor(), column, "f").expr));
      expect(
        normalize(encodeField(column.name, back.type, back.options, COLUMN_CONTEXT)),
        `${file} → ${column.name}`,
      ).toEqual(normalize(column));
    }
  });

  it("emits the current empty-customize form for every legacy column", () => {
    const legacy = TABLE_FIXTURES.flatMap((file) => {
      const table = readFixture(`tables/${file}`) as { schema?: FieldXdo[] };
      return (table.schema ?? []).filter((column) => column.customize === "");
    });
    expect(legacy.length).toBeGreaterThan(0);
    for (const column of legacy) {
      const ctx = new DecodeContext();
      const source = printExpr(decodeField(ctx, refsFor(), column, "f").expr);
      const back = evaluate(source);
      // The whole point: a legacy column is not quarantined into `rawField()`,
      // and what it re-exports carries `{}` — never the `""` it was read from.
      expect(source, column.name).not.toContain("rawField(");
      expect(
        encodeField(column.name, back.type, back.options, COLUMN_CONTEXT).customize,
        column.name,
      ).toEqual({});
    }
  });

  it("round-trips a column no authoring surface can produce, verbatim", () => {
    // `override` is encoder-fixed with no authoring option, so a column that sets
    // it cannot come back as any catalog call or descriptor — it rides through
    // `rawField()` byte-for-byte and is reported by name (R9). No fixture column
    // sets one, so the case is constructed rather than found.
    const column = {
      ...(readFixture("fields/enum-action.json") as FieldXdo),
      override: ["action"],
    };
    const ctx = new DecodeContext();
    const source = printExpr(decodeField(ctx, refsFor(), column, "f").expr);
    expect(source).toContain("rawField(");
    const back = evaluate(source);
    expect(encodeField(column.name, back.type, back.options, COLUMN_CONTEXT)).toEqual(column);
    expect(ctx.report.entries[0]!.detail).toContain("override");
  });
});

describe("decodeResponse", () => {
  it("returns undefined for a def that declared no response", () => {
    expect(decodeResponse(new DecodeContext(), [])).toBeUndefined();
  });

  it("round-trips a single unnamed value response", () => {
    const stored = encodeResponse(ref("user"));
    const ctx = new DecodeContext();
    const source = printExpr(decodeResponse(ctx, stored)!);
    expect(source).toBe('ref("user")');
    expect(encodeResponse(evaluateValue(source))).toEqual(stored);
  });

  it("round-trips a record response, preserving key order", () => {
    const stored = encodeResponse({ id: ref("user.id"), total: withFilters(ref("n"), fl.add(c.int(1))) });
    const ctx = new DecodeContext();
    const source = printExpr(decodeResponse(ctx, stored)!);
    expect(source.indexOf("id:")).toBeLessThan(source.indexOf("total:"));
    expect(encodeResponse(evaluateValue(source))).toEqual(stored);
  });

  it("drops a `disabled` response item — the engine skips it before anything else", () => {
    // The builder's `disabled` test runs BEFORE its blank-name test, so a lone
    // disabled entry never becomes the bare value: it is skipped, nothing
    // accumulates, and the response is null. So the def declares no response.
    const stored = encodeResponse(ref("user")).map((item) => ({ ...item, disabled: true }));
    const ctx = new DecodeContext();
    expect(decodeResponse(ctx, stored)).toBeUndefined();
    expect(ctx.report.entries[0]!.category).toBe("expected-omission");
  });

  it("drops the UNNAMED items in a multi-item result[] and keeps the record readable", () => {
    // A blank name has nothing to key the response object by, so the engine
    // skips it — unless it is the only entry, which is the bare-value case
    // below. This one query (four items, three unnamed) was the whole reason the
    // response fell back to `rawResponse()`; the engine's answer is that the
    // response really is just the one named item.
    const stored = [
      { name: "", tag: "var", value: "hello_1", filters: [], _xsid: "", disabled: false },
      { name: "", tag: "input", value: "ab", filters: [], _xsid: "", disabled: false },
      { name: "func_1", tag: "var", value: "func_1", filters: [], _xsid: "", disabled: false },
    ] as const satisfies readonly ResultItemXdo[];
    const ctx = new DecodeContext();
    const source = printExpr(decodeResponse(ctx, stored)!);
    expect(source).not.toContain("rawResponse(");
    expect(source).toContain("func_1");
    expect(ctx.report.entries[0]!.category).toBe("expected-omission");
    // The discard is visible, and what survives is what the engine builds.
    expect(encodeResponse(evaluateValue(source))).toEqual([
      { name: "func_1", tag: "var", value: "func_1", filters: [], _xsid: "", disabled: false },
    ]);
  });

  it("keeps a LONE unnamed item, which is the bare-value response", () => {
    // The paired negative for the rule above: `count === 1` is exactly when a
    // blank name is meaningful, and dropping it would erase the response.
    const stored = encodeResponse(ref("user"));
    const ctx = new DecodeContext();
    expect(printExpr(decodeResponse(ctx, stored)!)).toBe('ref("user")');
    expect(ctx.report.entries).toEqual([]);
  });

  it("carries a result[] with a REPEATED name through rawResponse()", () => {
    const stored = [
      { name: "id", tag: "var", value: "a", filters: [], _xsid: "", disabled: false },
      { name: "id", tag: "var", value: "b", filters: [], _xsid: "", disabled: false },
    ] as const satisfies readonly ResultItemXdo[];
    const ctx = new DecodeContext();
    const source = printExpr(decodeResponse(ctx, stored)!);
    expect(source).toContain("rawResponse(");
    expect(encodeResponse(evaluateValue(source))).toEqual(stored);
  });

  it("still uses the readable record form when every name is distinct", () => {
    // The paired negative — the raw path must not swallow the common case.
    const stored = encodeResponse({ id: ref("user.id"), total: ref("n") });
    const ctx = new DecodeContext();
    expect(printExpr(decodeResponse(ctx, stored)!)).not.toContain("rawResponse(");
    expect(ctx.report.entries).toEqual([]);
  });

  it("does NOT fall back for a non-empty _xsid, which is engine-generated", () => {
    // `_xsid` is on normalize()'s strip list — an editor id, not authored data,
    // so it can never fail verification. Treating it as unrepresentable would
    // push nearly every real query onto the raw path for nothing.
    const stored = encodeResponse(ref("user")).map((item) => ({ ...item, _xsid: "abc123" }));
    const ctx = new DecodeContext();
    const source = printExpr(decodeResponse(ctx, stored)!);
    expect(source).toBe('ref("user")');
    expect(ctx.report.entries).toEqual([]);
  });

  it("preserves absence — rawResponse() does not invent keys the item lacks", () => {
    // The contract `raw()` and `rawField()` both had to be fixed into. The
    // engine omits keys at their defaults, so completing them changes the bytes.
    // Reached via a REPEATED name, which is still unrepresentable as a record.
    const source = printExpr(
      decodeResponse(new DecodeContext(), [
        { name: "id", tag: "input", value: "user" } as never,
        { name: "id", tag: "input", value: "other" } as never,
      ])!,
    );
    expect(source).toContain("rawResponse(");
    const reencoded = encodeResponse(evaluateValue(source)) as unknown as Record<string, unknown>[];
    expect(Object.hasOwn(reencoded[0]!, "filters")).toBe(false);
    expect(Object.hasOwn(reencoded[0]!, "_xsid")).toBe(false);
    expect(reencoded[0]).toEqual({ name: "id", tag: "input", value: "user" });
  });
});

/** Evaluate a response expression against the real value constructors. */
function evaluateValue(source: string): never {
  const fn = new Function(
    "c", "ref", "withFilters", "fl", "rawValue", "rawResponse",
    `return (${source});`,
  );
  return fn(c, ref, withFilters, fl, rawValue, rawResponse) as never;
}
