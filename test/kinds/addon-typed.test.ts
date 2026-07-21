import { describe, it, expect, expectTypeOf } from "vitest";
import { addon, encodeAddon } from "../../src/kinds/addon.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { input } from "../../src/inputs/input.js";
import { s } from "../../src/statements/s.js";
import { col, inp, out, ref } from "../../src/values/value.js";
import { expr } from "../../src/statements/conditional.js";
import { cmp, or } from "../../src/statements/special/db-search.js";
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

  it.each(["count", "exists"] as const)("cardinality:'%s' encodes context.return.type", (card) => {
    const a = encodeAddon(addon({ name: "author", table: userTable, output: ["id"], cardinality: card }));
    expect(a.context).toEqual({
      dbo: { id: deriveGuid("dbo", userTable.name) },
      return: { type: card },
    });
  });

  it("cardinality:'aggregate' with group/eval encodes the full return.aggregate block", () => {
    const a = encodeAddon(
      addon({
        name: "author",
        table: userTable,
        cardinality: "aggregate",
        group: [{ name: "name", as: "grp" }],
        eval: [{ name: "id", as: "cnt", filters: [{ name: "count" }] }],
      }),
    );
    expect(a.context.return).toEqual({
      type: "aggregate",
      aggregate: {
        sort: [],
        eval: [{ as: "cnt", name: "id", filters: [{ name: "count", arg: [] }] }],
        group: [{ as: "grp", name: "name", filters: [] }],
      },
    });
  });

  it("where encodes context.search (same builder as db.query)", () => {
    const a = encodeAddon(
      addon({
        name: "author",
        table: userTable,
        output: ["id", "name"],
        where: expr(col("id"), "=", inp("user_id")),
        input: { user_id: input.int({ required: true }) },
      }),
    );
    const search = a.context.search as { expression: unknown[] };
    expect(search.expression).toHaveLength(1);
    expect(a.context.dbo).toEqual({ id: deriveGuid("dbo", userTable.name) });
  });

  it("addon where inherits the extended operators + nested groups (M2 overlap)", () => {
    const a = encodeAddon(
      addon({
        name: "author",
        table: userTable,
        output: ["id"],
        where: or(cmp(col("name"), "ilike", inp("q")), expr(col("id"), "=", inp("uid"))),
        input: { q: input.text(), uid: input.int() },
      }),
    );
    const top = (a.context.search as { expression: { type: string; group: { expression: { op?: string; or: boolean }[] } }[] })
      .expression;
    expect(top[0]!.type).toBe("group");
    expect(top[0]!.group.expression[1]!.or).toBe(true);
  });

  it("sort encodes context.sort as {sortBy, orderBy}", () => {
    const a = encodeAddon(
      addon({ name: "author", table: userTable, output: ["id"], sort: [{ sortBy: "name" }, { sortBy: "id", dir: "desc" }] }),
    );
    expect(a.context.sort).toEqual([
      { sortBy: "name", orderBy: "asc" },
      { sortBy: "id", orderBy: "desc" },
    ]);
  });

  it("explicit context.search / context.sort win over where / sort", () => {
    const a = encodeAddon(
      addon({
        name: "author",
        table: userTable,
        where: expr(col("id"), "=", inp("user_id")),
        sort: [{ sortBy: "name" }],
        context: { search: { expression: [] }, sort: [{ sortBy: "id", orderBy: "asc" }] },
      }),
    );
    expect(a.context.search).toEqual({ expression: [] });
    expect(a.context.sort).toEqual([{ sortBy: "id", orderBy: "asc" }]);
  });

  it("explicit context.dbo / context.return win over the auto-fill", () => {
    const a = encodeAddon(
      addon({
        name: "author",
        table: userTable,
        cardinality: "single",
        // Same type as `cardinality` (no conflict), but a richer explicit block —
        // proves the author's `return` is preserved verbatim, not overwritten by the auto-fill.
        context: { dbo: { id: "explicit-guid" }, return: { type: "single", listable: false } },
      }),
    );
    expect(a.context).toEqual({ dbo: { id: "explicit-guid" }, return: { type: "single", listable: false } });
  });

  it("conflicting cardinality vs explicit context.return.type throws", () => {
    expect(() =>
      encodeAddon(
        addon({ name: "author", table: userTable, cardinality: "single", context: { return: { type: "list" } } }),
      ),
    ).toThrow(/cardinality/);
  });

  it("empty sort is dropped, not written as context.sort: []", () => {
    const a = encodeAddon(addon({ name: "author", table: userTable, output: ["id"], sort: [] }));
    expect(a.context.sort).toBeUndefined();
  });

  it("malformed where (typo'd comparison) throws instead of shipping a garbage search", () => {
    // `operator` instead of `op` — not comparison-shaped and not a tagged Value.
    expect(() =>
      encodeAddon(
        addon({ name: "author", table: userTable, where: { operator: "=", left: col("id") } as never }),
      ),
    ).toThrow(/must be an expr/);
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
  });

  const authorSingle = addon({
    name: "author_single",
    table: userTable,
    output: ["id", "name"],
    cardinality: "single",
    input: { user_id: input.int({ required: true }) },
  });


  it("list addon → graft typed as the picked columns array", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q1",
      stack: [s.db.query({ table: chirp, addon: [{ addon: authorAddon, as: "_author", input: { user_id: out("author") } }], as: "rows" })],
      response: ref("rows"),
    });
    expect(q).toBeDefined();
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
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<{ id: number; name: string }>();
  });

  const countAddon = addon({ name: "chirp_count", table: userTable, cardinality: "count", input: { user_id: input.int() } });
  const existsAddon = addon({ name: "chirp_exists", table: userTable, cardinality: "exists", input: { user_id: input.int() } });
  const aggAddon = addon({ name: "chirp_agg", table: userTable, cardinality: "aggregate", input: { user_id: input.int() } });

  it("count addon → graft typed as number", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "qcount",
      stack: [s.db.query({ table: chirp, addon: [{ addon: countAddon, as: "_author", input: { user_id: out("author") } }], as: "rows" })],
      response: ref("rows"),
    });
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<number>();
  });

  it("exists addon → graft typed as boolean", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "qexists",
      stack: [s.db.query({ table: chirp, addon: [{ addon: existsAddon, as: "_author", input: { user_id: out("author") } }], as: "rows" })],
      response: ref("rows"),
    });
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<boolean>();
  });

  it("aggregate addon → graft stays unknown (shape driven by group/eval)", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "qagg",
      stack: [s.db.query({ table: chirp, addon: [{ addon: aggAddon, as: "_author", input: { user_id: out("author") } }], as: "rows" })],
      response: ref("rows"),
    });
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<unknown>();
  });

  it("aggregate addon WITH group/eval → graft typed by the aliases (U10)", () => {
    const typedAgg = addon({
      name: "chirp_agg2",
      table: userTable,
      cardinality: "aggregate",
      group: [{ name: "name", as: "grp" }],
      eval: [{ name: "id", as: "cnt", filters: [{ name: "count" }] }],
      input: { user_id: input.int() },
    });
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "qagg2",
      stack: [s.db.query({ table: chirp, addon: [{ addon: typedAgg, as: "_stats", input: { user_id: out("author") } }], as: "rows" })],
      response: ref("rows"),
    });
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    type Stats = Row["_stats"];
    expectTypeOf<Stats>().toEqualTypeOf<Array<{ grp: unknown; cnt: unknown }>>();
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
    expect(q).toBeDefined();
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
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<{ id: number }>();
  });

  it("attachment output on a count/exists addon preserves the scalar graft (never collapses to {})", () => {
    // Guards NarrowGraft's `G extends object ? Pick : G` branch: an attachment-level
    // `output` must not run a number/boolean graft through `Pick` (→ `{}`).
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q_scalar_output",
      stack: [
        s.db.query({
          table: chirp,
          addon: [
            { addon: countAddon, as: "_count", input: { user_id: out("author") }, output: ["id"] },
            { addon: existsAddon, as: "_exists", input: { user_id: out("author") }, output: ["id"] },
          ],
          as: "rows",
        }),
      ],
      response: ref("rows"),
    });
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_count"]>().toEqualTypeOf<number>();
    expectTypeOf<Row["_exists"]>().toEqualTypeOf<boolean>();
  });

  it("attachment output on a bare-name addon stays unknown (never collapses to {})", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q6",
      stack: [s.db.query({ table: chirp, addon: [{ addon: "author", as: "_author", output: ["name"] }], as: "rows" })],
      response: ref("rows"),
    });
    expect(q).toBeDefined();
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
    expect(q).toBeDefined();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row["_author"]>().toEqualTypeOf<unknown>();
  });
});
