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
import { COLUMN_CONTEXT, INPUT_CONTEXT, encodeField } from "../../src/fields/field.js";
import { f } from "../../src/fields/catalog.js";
import type { FieldDescriptor } from "../../src/fields/catalog.js";
import { input } from "../../src/inputs/input.js";
import { encodeResponse } from "../../src/responses/response.js";
import { c, ref, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { rawValue } from "../../src/values/raw-value.js";
import { rawResponse } from "../../src/responses/raw-response.js";
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
    const stored = { ...encodeField("x", "text", {}, COLUMN_CONTEXT), merge: true };
    const ctx = new DecodeContext();
    const decoded = decodeField(ctx, refsFor(), stored, "f");
    const source = printExpr(decoded.expr);
    expect(source).toContain("rawField(");
    const back = evaluate(source);
    expect(encodeField("x", back.type, back.options, COLUMN_CONTEXT)).toEqual(stored);
    expect(ctx.report.entries[0]!.detail).toContain("merge");
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
  ] as Array<[string, FieldDescriptor]>)("round-trips input.%s identically", (name, descriptor) => {
    identity(name, descriptor, "input");
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
  it("round-trips the single field fixture verbatim through rawField", () => {
    // `enum-action.json` is older-vintage like several table columns: it stores
    // `customize: ""` where the current encoder writes `{}`, so no `f.*` form can
    // reproduce it. It still round-trips byte-for-byte via `rawField()`.
    const stored = readFixture("fields/enum-action.json") as FieldXdo;
    expect(stored.customize).toBe("");
    const ctx = new DecodeContext();
    const back = evaluate(printExpr(decodeField(ctx, refsFor(), stored, "f").expr));
    expect(encodeField(stored.name, back.type, back.options, COLUMN_CONTEXT)).toEqual(stored);
    expect(ctx.report.entries[0]!.detail).toContain("customize");
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
   * Some fixture columns predate the current field encoder and store
   * `customize: ""` where it now writes `{}` — a shape no authoring surface can
   * produce, so those columns cannot round-trip by construction. They are
   * separated here rather than skipped: the reporting assertion below is the one
   * that matters for them (R9).
   */
  const producible = (column: FieldXdo) => column.customize !== "";

  // Every column, including the ones no `f.*` form can express — those ride
  // through `rawField()`. There is no such thing as a column that fails to
  // round-trip, which is the whole point of the three escape hatches.
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
        encodeField(column.name, back.type, back.options, COLUMN_CONTEXT),
        `${file} → ${column.name}`,
      ).toEqual(column);
    }
  });

  it("round-trips a column no authoring surface can produce, verbatim", () => {
    const legacy = TABLE_FIXTURES.flatMap((file) => {
      const table = readFixture(`tables/${file}`) as { schema?: FieldXdo[] };
      return (table.schema ?? []).filter((column) => !producible(column));
    });
    expect(legacy.length).toBeGreaterThan(0);
    for (const column of legacy) {
      const ctx = new DecodeContext();
      const source = printExpr(decodeField(ctx, refsFor(), column, "f").expr);
      expect(source, column.name).toContain("rawField(");
      const back = evaluate(source);
      expect(encodeField(column.name, back.type, back.options, COLUMN_CONTEXT), column.name).toEqual(
        column,
      );
      expect(ctx.report.entries[0]!.detail, column.name).toContain("customize");
    }
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

  it("carries a response item that sets `disabled` through rawResponse(), exactly", () => {
    // `encodeResponse` writes `disabled` unconditionally at its default, so no
    // authoring surface reaches it. Previously this was reported and then lost;
    // now it round-trips verbatim.
    const stored = encodeResponse(ref("user")).map((item) => ({ ...item, disabled: true }));
    const ctx = new DecodeContext();
    const source = printExpr(decodeResponse(ctx, stored)!);
    expect(source).toContain("rawResponse(");
    expect(ctx.report.entries[0]!.category).toBe("raw-fallback");
    expect(encodeResponse(evaluateValue(source))).toEqual(stored);
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
    const source = printExpr(
      decodeResponse(new DecodeContext(), [
        { name: "", tag: "input", value: "user", disabled: true } as never,
      ])!,
    );
    const reencoded = encodeResponse(evaluateValue(source)) as unknown as Record<string, unknown>[];
    expect(Object.hasOwn(reencoded[0]!, "filters")).toBe(false);
    expect(Object.hasOwn(reencoded[0]!, "_xsid")).toBe(false);
    expect(reencoded[0]).toEqual({ name: "", tag: "input", value: "user", disabled: true });
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
