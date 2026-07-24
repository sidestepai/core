import { describe, it, expect } from "vitest";
import { input, encodeInput } from "../src/inputs/input.js";
import { f } from "../src/fields/catalog.js";
import { inp } from "../src/values/value.js";
import type { InputDescriptor } from "../src/inputs/input.js";

/**
 * The `name` input entry in the persisted form: inputs share the column field
 * shape — `_xsid:""`, `customize:{}`, numeric `market_item` ids.
 */
const FIXTURE_NAME_INPUT = {
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
};

describe("encodeInput", () => {
  it("text with methods:['trim'] matches the fixture's name input exactly", () => {
    expect(encodeInput("name", input.text({ required: false, methods: ["trim"] }))).toEqual(
      FIXTURE_NAME_INPUT,
    );
  });

  it("int matches the fixture's score input (empty methods)", () => {
    const encoded = encodeInput("score", input.int());
    expect(encoded.name).toBe("score");
    expect(encoded.type).toBe("int");
    expect(encoded.methods).toEqual([]);
    expect(encoded.required).toBe(false);
    expect(encoded.vector).toEqual({ size: 3 });
  });

  it("required/nullable/default flow into the right fields", () => {
    const encoded = encodeInput(
      "title",
      input.text({ required: true, nullable: true, default: "untitled" }),
    );
    expect(encoded.required).toBe(true);
    expect(encoded.nullable).toBe(true);
    expect(encoded.default).toBe("untitled");
  });

  it("empty methods yields methods:[]", () => {
    expect(encodeInput("x", input.text()).methods).toEqual([]);
  });

  it("emits the _xsid placeholder (engine fills it on import)", () => {
    expect(encodeInput("name", input.text())._xsid).toBe("");
  });

  it("exposes the common scalar types beyond text/int", () => {
    expect(encodeInput("e", input.email()).type).toBe("email");
    expect(encodeInput("b", input.bool()).type).toBe("bool");
    expect(encodeInput("d", input.decimal()).type).toBe("decimal");
    expect(encodeInput("ts", input.timestamp()).type).toBe("epochms");
    expect(encodeInput("j", input.json()).type).toBe("json");
    expect(encodeInput("u", input.uuid()).type).toBe("uuid");
  });

  it("input.url encodes to the engine `text` type (no native url type) and keeps text methods (#12)", () => {
    // There is no engine `url` type — a fake one would be rejected at push (cf.
    // the #15 unique-index bug). `input.url()` is a text field; http(s)
    // enforcement is a boundary guard, not the type.
    expect(encodeInput("link", input.url()).type).toBe("text");
    expect(encodeInput("link", input.url({ required: true, methods: ["trim"] })).methods).toEqual([
      { name: "trim", arg: [], disabled: false },
    ]);
  });

  it("enum carries its values and requires a non-empty list", () => {
    const enc = encodeInput("status", input.enum(["active", "archived"]));
    expect(enc.type).toBe("enum");
    expect(enc.values).toEqual(["active", "archived"]);
    expect(() => input.enum([])).toThrow(/at least one value/);
  });

  it("object encodes type 'obj' with typed children", () => {
    const enc = encodeInput("user", input.object({ name: f.text(), age: f.int() }));
    expect(enc.type).toBe("obj");
    const kids = enc.children as Array<{ name: string; type: string }>;
    expect(kids.map((c) => [c.name, c.type])).toEqual([
      ["name", "text"],
      ["age", "int"],
    ]);
  });

  it("list wraps a scalar element as style:list keeping its type and methods", () => {
    const enc = encodeInput("tags", input.list(input.text({ methods: ["trim"] })));
    expect(enc.type).toBe("text");
    expect(enc.style).toEqual({ type: "list" });
    expect(enc.methods).toEqual([{ name: "trim", disabled: false, arg: [] }]);
  });

  it("list of objects keeps the obj type, children, and list style", () => {
    const enc = encodeInput("items", input.list(input.object({ id: f.int() }), { required: true }));
    expect(enc.type).toBe("obj");
    expect(enc.style).toEqual({ type: "list" });
    expect(enc.required).toBe(true);
    expect((enc.children as Array<{ name: string }>).map((c) => c.name)).toEqual(["id"]);
  });

  it("list rejects a non-descriptor element", () => {
    // @ts-expect-error — element must be an input descriptor
    expect(() => input.list("text")).toThrow(/element constructor/);
  });

  it("mirrors the f.* catalog: file, geo, and vector input types", () => {
    expect(encodeInput("avatar", input.image()).type).toBe("blob_img");
    expect(encodeInput("clip", input.video()).type).toBe("blob_video");
    expect(encodeInput("song", input.audio()).type).toBe("blob_audio");
    expect(encodeInput("doc", input.attachment()).type).toBe("blob");
    expect(encodeInput("loc", input.geo.point()).type).toBe("geo_point");
    expect(encodeInput("area", input.geo.polygon()).type).toBe("geo_polygon");
    const vec = encodeInput("emb", input.vector(1536));
    expect(vec.type).toBe("vector");
    expect(vec.vector).toEqual({ size: 1536 });
  });

  it("tableRef input carries the target table's guid as an `@` method", () => {
    const enc = encodeInput("author", input.tableRef("users", { type: "int" }));
    expect(enc.type).toBe("int");
    const at = enc.methods.find((m) => (m as { name: string }).name === "@") as {
      arg: string[];
    };
    expect(at).toBeDefined();
    expect(at.arg[0]).toMatch(/^dbo=/);
  });

  it("a list of file inputs is style:list over the blob type", () => {
    const enc = encodeInput("gallery", input.list(input.image()));
    expect(enc.type).toBe("blob_img");
    expect(enc.style).toEqual({ type: "list" });
  });

  // #124.2 — the `inp(...)` (value ref) vs `input.*` (descriptor) collision. A
  // value ref slipped into an `input:` map (via JS/`any`, past the TS guard)
  // fails loudly with a message naming the fix, not a silently-broken field.
  it("rejects a value ref (inp) passed where an input descriptor is required", () => {
    const wrong = inp("author") as unknown as InputDescriptor;
    expect(() => encodeInput("author", wrong)).toThrow(/value ref/);
    expect(() => encodeInput("author", wrong)).toThrow(/input\.text\(\)/);
  });
});
