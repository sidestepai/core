import { describe, it, expect, expectTypeOf } from "vitest";
import { addon, encodeAddon } from "../../src/kinds/addon.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { input } from "../../src/inputs/input.js";
import { s } from "../../src/statements/s.js";
import { inp, out, ref } from "../../src/values/value.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import type { InferResponse } from "../../src/responses/infer.js";

/**
 * Typed addon authoring (issues #62, #63): `addon({ table, output })` auto-fills
 * the `context.dbo` binding and brands the handle with its graft shape, and
 * `cardinality:"single"` encodes `context.return.type` + types the graft as an
 * object instead of an array.
 */

const userTable = table({
  name: "user",
  schema: {
    name: f.text({ required: true }),
    age: f.int(),
  },
});

describe("addon() typed authoring — encode", () => {
  it("table + output[] fills context.dbo and the customized output block", () => {
    const a = encodeAddon(
      addon({
        name: "author",
        table: userTable,
        output: ["id", "name"],
        input: { user_id: input.int({ required: true }) },
        stack: [s.db.get({ table: userTable, fieldValue: inp("user_id"), output: ["id", "name"], as: "author" })],
      }),
    );
    expect(a.context).toEqual({ dbo: { id: deriveGuid("dbo", userTable.name) } });
    expect(a.output).toEqual({ customize: true, items: [{ name: "id" }, { name: "name" }] });
  });

  it("cardinality:'single' encodes context.return.type = single", () => {
    const a = encodeAddon(addon({ name: "author", table: userTable, output: ["id", "name"], cardinality: "single" }));
    expect(a.context).toEqual({
      dbo: { id: deriveGuid("dbo", userTable.name) },
      return: { type: "single" },
    });
  });

  it("default (list) omits the return block", () => {
    const a = encodeAddon(addon({ name: "author", table: userTable, output: ["id"] }));
    expect(a.context.return).toBeUndefined();
  });

  it("explicit context.dbo / context.return win over the auto-fill", () => {
    const a = encodeAddon(
      addon({
        name: "author",
        table: userTable,
        cardinality: "single",
        context: { dbo: { id: "explicit-guid" }, return: { type: "list" } },
      }),
    );
    expect(a.context).toEqual({ dbo: { id: "explicit-guid" }, return: { type: "list" } });
  });

  it("no table/output → unchanged empty context + full-record output (back-compat)", () => {
    const a = encodeAddon(addon({ name: "bare" }));
    expect(a.context).toEqual({});
    expect(a.output).toEqual({ customize: false, items: [] });
  });

  it("raw output block still passes through verbatim", () => {
    const a = encodeAddon(addon({ name: "raw", output: { customize: true, items: [{ name: "x" }] } }));
    expect(a.output).toEqual({ customize: true, items: [{ name: "x" }] });
  });
});

describe("addon() typed authoring — graft types on db.query", () => {
  const group = apiGroup({ name: "g", canonical: "addon-typed" });
  const chirp = table({
    name: "chirp",
    schema: { text: f.text({ required: true }), author: f.int() },
  });

  const authorAddon = addon({
    name: "author",
    table: userTable,
    output: ["id", "name"],
    input: { user_id: input.int({ required: true }) },
    stack: [s.db.get({ table: userTable, fieldValue: inp("user_id"), output: ["id", "name"], as: "author" })],
  });

  const authorSingle = addon({
    name: "author_single",
    table: userTable,
    output: ["id", "name"],
    cardinality: "single",
    input: { user_id: input.int({ required: true }) },
    stack: [s.db.get({ table: userTable, fieldValue: inp("user_id"), output: ["id", "name"], as: "author" })],
  });

  it("list addon → graft typed as the picked columns array", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q1",
      stack: [s.db.query({ table: chirp, addon: [{ addon: authorAddon, as: "_author", input: { user_id: out("author") } }], as: "rows" })],
      response: ref("rows"),
    });
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<{ id: number; name: string }[]>();
  });

  it("single addon → graft typed as one picked-columns object", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q2",
      stack: [s.db.query({ table: chirp, addon: [{ addon: authorSingle, as: "_author", input: { user_id: out("author") } }], as: "rows" })],
      response: ref("rows"),
    });
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<{ id: number; name: string }>();
  });

  it("collision detection: shadowing alias throws, non-colliding + bare-name are fine", () => {
    // `text` is a real chirp column → throws.
    expect(() =>
      s.db.query({ table: chirp, addon: [{ addon: authorAddon, as: "text", input: { user_id: out("author") } }], as: "rows" }),
    ).toThrow(/shadows an existing "chirp" column/);
    // `_author` collides with nothing → builds fine.
    expect(() =>
      s.db.query({ table: chirp, addon: [{ addon: authorAddon, as: "_author", input: { user_id: out("author") } }], as: "rows" }),
    ).not.toThrow();
    // Bare-name table has no enumerable columns → detection is skipped (no false positive).
    expect(() => s.db.query({ table: "chirp", addon: [{ addon: "author", as: "text" }], as: "rows" })).not.toThrow();
  });

  it("attachment output narrows a list graft to the whitelisted columns", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q4",
      stack: [
        s.db.query({
          table: chirp,
          addon: [{ addon: authorAddon, as: "_author", input: { user_id: out("author") }, output: ["name"] }],
          as: "rows",
        }),
      ],
      response: ref("rows"),
    });
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<{ name: string }[]>();
  });

  it("attachment output narrows a single graft to the whitelisted columns", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q5",
      stack: [
        s.db.query({
          table: chirp,
          addon: [{ addon: authorSingle, as: "_author", input: { user_id: out("author") }, output: ["id"] }],
          as: "rows",
        }),
      ],
      response: ref("rows"),
    });
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<{ id: number }>();
  });

  it("attachment output on a bare-name addon stays unknown (never collapses to {})", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q6",
      stack: [s.db.query({ table: chirp, addon: [{ addon: "author", as: "_author", output: ["name"] }], as: "rows" })],
      response: ref("rows"),
    });
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<unknown>();
  });

  it("bare-name addon → graft stays unknown", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q3",
      stack: [s.db.query({ table: chirp, addon: [{ addon: "author", as: "_author" }], as: "rows" })],
      response: ref("rows"),
    });
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<unknown>();
  });
});
