import { describe, it, expect } from "vitest";
import { encodeField, INPUT_CONTEXT, COLUMN_CONTEXT } from "../../src/fields/field.js";
import { encodeInput, input } from "../../src/inputs/input.js";
import { normalize, loadFixture } from "../conformance/harness.js";

interface TableFixture {
  schema: Array<Record<string, unknown>>;
}
const table = loadFixture<TableFixture>("tables/schema-table.json");
const fixtureCol = (name: string) => table.schema.find((c) => c.name === name)!;

describe("encodeField — input context (unchanged MVP behavior)", () => {
  it("encodeInput still matches the function input shape exactly", () => {
    const encoded = encodeInput("name", input.text({ required: false, methods: ["trim"] }));
    expect(encoded).toEqual({
      name: "name",
      type: "text",
      _xsid: "",
      description: "",
      nullable: false,
      default: "",
      merge: false,
      hidden: [],
      override: [],
      customize: {},
      required: false,
      values: [],
      mode: "",
      format: "",
      sensitive: false,
      list: { min: "", max: "" },
      vector: { size: 3 },
      access: "public",
      style: { type: "single" },
      children: [],
      methods: [{ name: "trim", disabled: false, arg: [] }],
      market_item: { id: 0, version: 0, guid: "" },
      is_settings_registry: false,
    });
  });

  it("input context matches column context: customize:{} + numeric market_item ids", () => {
    const f = encodeField("x", "text", {}, INPUT_CONTEXT);
    expect(f.customize).toEqual({});
    expect(f.market_item).toEqual({ id: 0, version: 0, guid: "" });
  });
});

describe("encodeField — column context (matches real table fixture)", () => {
  it("encodes the 'id' column to the fixture shape (minus _xsid)", () => {
    const encoded = encodeField("id", "int", { required: true }, COLUMN_CONTEXT);
    expect(normalize(encoded)).toEqual(normalize(fixtureCol("id")));
  });

  it("encodes the 'created_at' column (default 'now', private access)", () => {
    const encoded = encodeField(
      "created_at",
      "epochms",
      { default: "now", access: "private" },
      COLUMN_CONTEXT,
    );
    expect(normalize(encoded)).toEqual(normalize(fixtureCol("created_at")));
  });

  it("encodes the 'name' column", () => {
    const encoded = encodeField("name", "text", { required: true }, COLUMN_CONTEXT);
    expect(normalize(encoded)).toEqual(normalize(fixtureCol("name")));
  });

  it("column context uses numeric market_item ids and customize:{}", () => {
    const f = encodeField("x", "text", {}, COLUMN_CONTEXT);
    expect(f.customize).toEqual({});
    expect(f.market_item).toEqual({ id: 0, version: 0, guid: "" });
  });
});
