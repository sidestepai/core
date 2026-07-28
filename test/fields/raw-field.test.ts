/**
 * `rawField()` — the field-level verbatim passthrough.
 *
 * Completes the no-data-loss set: `raw()` for statements, `rawValue()` for
 * values, `rawField()` for schema and input fields. Together they mean nothing a
 * Xano workspace stores is dropped on the way into TypeScript.
 */
import { describe, it, expect } from "vitest";
import { rawField } from "../../src/fields/raw-field.js";
import { COLUMN_CONTEXT, INPUT_CONTEXT, encodeField } from "../../src/fields/field.js";
import { f } from "../../src/fields/catalog.js";
import { encodeColumn } from "../../src/kinds/table.js";
import { encodeInput } from "../../src/inputs/input.js";

/** A complete stored column, shaped as a bundle's `schema[]` entry. */
const FULL_FIELD = {
  name: "action",
  type: "enum",
  _xsid: "i:9fd88847-ea7c-4ede-828e-97b7b451c3f4",
  description: "",
  nullable: false,
  default: "message",
  merge: false,
  hidden: [],
  override: [],
  // The older encoder vintage: `""` where the current one writes `{}`.
  customize: "",
  required: false,
  values: ["message", "email"],
  mode: "",
  format: "",
  sensitive: false,
  list: { min: "", max: "" },
  vector: { size: 3 },
  access: "public",
  style: { type: "single" },
  children: [],
  methods: [],
  market_item: { id: 0, version: 0, guid: "" },
  is_settings_registry: false,
};

/** Encode a raw field as a table column. */
const asColumn = (envelope: Record<string, unknown>) => {
  const descriptor = rawField(envelope);
  return encodeField(String(envelope.name), descriptor.type, descriptor.options, COLUMN_CONTEXT);
};

describe("rawField()", () => {
  it("encodes a full stored envelope byte-identical to its input", () => {
    expect(asColumn(FULL_FIELD)).toEqual(FULL_FIELD);
  });

  it("preserves keys no authoring option can reach", () => {
    const stored = { ...FULL_FIELD, merge: true, is_settings_registry: true, hidden: ["x"] };
    expect(asColumn(stored)).toMatchObject({
      merge: true,
      is_settings_registry: true,
      hidden: ["x"],
      customize: "",
    });
  });

  it("preserves an unknown extra key — a field shape Xano ships later", () => {
    const encoded = asColumn({ ...FULL_FIELD, quantum_flag: { a: 1 } }) as unknown as Record<
      string,
      unknown
    >;
    expect(encoded.quantum_flag).toEqual({ a: 1 });
  });

  it("preserves a disabled method, which encodeMethods cannot express", () => {
    const methods = [{ name: "trim", disabled: true, arg: [] }];
    expect(asColumn({ ...FULL_FIELD, methods }).methods).toEqual(methods);
  });

  it("preserves a lean envelope exactly, inventing no keys", () => {
    // Passthrough means passthrough. A real pulled workspace stored a `uuid`
    // column with no `default` at all; completing it re-introduced `default: ""`
    // and broke the round trip this function exists to guarantee.
    expect(asColumn({ name: "title", type: "text" })).toEqual({ name: "title", type: "text" });
  });

  it("keeps canonical key ORDER while carrying only the keys present", () => {
    // Ordering stays normalized so output is deterministic regardless of how the
    // input object was built; presence is not.
    expect(Object.keys(asColumn({ required: true, type: "text", name: "title" }))).toEqual([
      "name",
      "type",
      "required",
    ]);
  });

  it("omits description when the stored envelope has none", () => {
    expect(Object.hasOwn(asColumn({ name: "t", type: "text" }), "description")).toBe(false);
    expect(asColumn({ name: "t", type: "text", description: "hi" }).description).toBe("hi");
  });

  it("carries through encodeColumn, the table schema path", () => {
    const descriptor = rawField(FULL_FIELD);
    expect(encodeColumn({ name: FULL_FIELD.name, type: descriptor.type, ...descriptor.options })).toEqual(
      FULL_FIELD,
    );
  });

  it("carries through encodeInput, the input path", () => {
    const stored = { ...FULL_FIELD, name: "kind", customize: "" };
    expect(encodeInput("kind", rawField(stored))).toEqual(stored);
  });

  it("short-circuits at its own depth inside an object column's children", () => {
    const child = { ...FULL_FIELD, name: "nested", merge: true };
    const childDescriptor = rawField(child);
    const parent = f.object({ nested: childDescriptor });
    const encoded = encodeField("parent", parent.type, parent.options, COLUMN_CONTEXT);
    expect(encoded.children).toEqual([child]);
  });

  it("lets the envelope's own name and type win over its surroundings", () => {
    // Preservation is the contract: nothing about the stored shape is rewritten
    // to agree with the key it was attached to.
    const descriptor = rawField({ name: "stored_name", type: "int" });
    expect(encodeField("map_key", descriptor.type, descriptor.options, COLUMN_CONTEXT).name).toBe(
      "stored_name",
    );
  });

  it("rejects an envelope missing name or type, naming what is required", () => {
    expect(() => rawField({} as never)).toThrow(/name/i);
    expect(() => rawField({ name: "x" } as never)).toThrow(/type/i);
    expect(() => rawField(null as never)).toThrow(/envelope/i);
    expect(() => rawField([] as never)).toThrow(/envelope/i);
  });

  it("leaves the normal encode path untouched for authored fields", () => {
    expect(encodeField("email", "email", { required: true }, INPUT_CONTEXT)).toMatchObject({
      customize: {},
      required: true,
    });
  });
});
