import { describe, it, expect, expectTypeOf } from "vitest";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { ref, out, c, inp } from "../../src/values/value.js";
import { input } from "../../src/inputs/input.js";
import { s } from "../../src/statements/s.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { InferRow } from "../../src/kinds/table.js";

/**
 * Type-level guard for the `db.query` paging envelope (issue #58) and the
 * addon-augmented row shape in `InferResponse`.
 *
 * The envelope shape mirrors the engine's `XS::packageListMeta` OpenAPI schema
 * (`x2/.../helper/XS.php:5437`): the row list under `items` plus paging metadata,
 * and `itemsTotal`/`pageTotal` only when `totals:true`. Addon aliases mirror
 * `XS::applyAddOnSchema` — the last segment of each `as` lands on the row element,
 * valued `unknown` (the SDK cannot type the referenced addon's return columns).
 */

const group = apiGroup({ name: "g", canonical: "paging-addon-types" });

const book = table({
  name: "book",
  schema: {
    name: f.text({ required: true }),
    pages: f.int(),
  },
});

type Book = InferRow<typeof book>;

describe("db.query paging envelope + addon response typing", () => {
  it("no paging → bare row list (unchanged)", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q1",
      stack: [s.db.query({ table: book, as: "rows" })],
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<Book[]>();
  });

  it("paging with metadata on (default) → wraps the list in the paging envelope", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q2",
      stack: [s.db.query({ table: book, paging: { per_page: 25 }, as: "rows" })],
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<{
      items: Book[];
      itemsReceived: number;
      curPage: number;
      nextPage: number | null;
      prevPage: number | null;
      offset: number;
      perPage: number;
    }>();
  });

  it("paging with metadata:false → stays a bare row list", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q3",
      stack: [s.db.query({ table: book, paging: { per_page: 25, metadata: false }, as: "rows" })],
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<Book[]>();
  });

  it("paging with totals:true → envelope also carries itemsTotal/pageTotal", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q4",
      stack: [s.db.query({ table: book, paging: { per_page: 25, totals: true }, as: "rows" })],
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    expectTypeOf<InferResponse<typeof q>>().toMatchTypeOf<{
      items: Book[];
      itemsTotal: number;
      pageTotal: number;
    }>();
  });

  it("input-bound page (Value) still yields the paging envelope (issue #66)", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q4b",
      stack: [s.db.query({ table: book, paging: { page: inp("page"), per_page: 20 }, as: "rows" })],
      input: { page: input.int({ default: 1 }) },
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<{
      items: Book[];
      itemsReceived: number;
      curPage: number;
      nextPage: number | null;
      prevPage: number | null;
      offset: number;
      perPage: number;
    }>();
  });

  it("has-next signal: envelope exposes nextPage: number|null and typed itemsTotal (issue #66 bonus)", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q4d",
      stack: [
        s.db.query({ table: book, paging: { page: inp("page"), totals: true }, as: "rows" }),
      ],
      input: { page: input.int({ default: 1 }) },
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    type Env = InferResponse<typeof q>;
    expectTypeOf<Env>().toMatchTypeOf<{ nextPage: number | null; itemsTotal: number; pageTotal: number }>();
  });

  it("search/sort-only paging (no page field) → bare row list, not the truncated envelope", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q4c",
      stack: [s.db.query({ table: book, paging: { search: inp("q"), sort: inp("s") }, as: "rows" })],
      input: { q: input.text(), s: input.text() },
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<Book[]>();
  });

  // `toEqualTypeOf` is finicky comparing an `unknown`-valued key across a
  // flattened row vs an intersection, so the addon cases assert the two facts
  // that matter separately: the row keeps all its base columns, and the alias is
  // present typed `unknown`.
  it("addon on a bare list → each row gains the alias key as unknown", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q5",
      stack: [
        s.db.query({
          table: book,
          addon: [{ addon: "author", as: "_author", input: { id: out("id") } }],
          as: "rows",
        }),
      ],
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row>().toMatchTypeOf<Book>();
    expectTypeOf<Row["_author"]>().toEqualTypeOf<unknown>();
  });

  it("addon `as` splits at the last dot → only the alias becomes the row key", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q6",
      stack: [s.db.query({ table: book, addon: [{ addon: "author", as: "items._author" }], as: "rows" })],
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    type Row = InferResponse<typeof q>[number];
    expectTypeOf<Row>().toMatchTypeOf<Book>();
    expectTypeOf<Row["_author"]>().toEqualTypeOf<unknown>();
    // The offset segment ("items") is NOT a row key — only the alias lands.
    expectTypeOf<Row>().not.toHaveProperty("items");
  });

  it("addon + paging → the alias lands on each row inside the envelope's items", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q7",
      stack: [
        s.db.query({
          table: book,
          paging: { per_page: 10 },
          addon: [{ addon: "author", as: "items._author" }],
          as: "rows",
        }),
      ],
      response: ref("rows"),
    });
    expectTypeOf(q).toBeObject();
    type Item = InferResponse<typeof q>["items"][number];
    expectTypeOf<Item>().toMatchTypeOf<Book>();
    expectTypeOf<Item["_author"]>().toEqualTypeOf<unknown>();
  });

  it("db.get with an addon → the single row gains the alias key", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q8",
      stack: [
        s.db.get({
          table: book,
          fieldValue: c.int(1),
          addon: [{ addon: "author", as: "_author" }],
          as: "row",
        }),
      ],
      response: ref("row"),
    });
    expectTypeOf(q).toBeObject();
    type Row = InferResponse<typeof q>;
    expectTypeOf<Row>().toMatchTypeOf<Book>();
    expectTypeOf<Row["_author"]>().toEqualTypeOf<unknown>();
  });

  // Issue #61: an addon alias that shadows an existing column is almost always a
  // mistake — the engine grafts over that field at runtime and desyncs the row.
  // On a typed table the SDK detects it at author time and throws (the issue's
  // preferred fix); the type-level override (WithAddons) is the belt-and-suspenders
  // for bare-name tables whose columns can't be enumerated.
  it("addon alias shadowing a base column throws at author time", () => {
    expect(() =>
      s.db.query({
        table: book,
        // `name` already exists on the table; the addon would graft over it.
        addon: [{ addon: "author", as: "name", input: { id: out("id") } }],
        as: "rows",
      }),
    ).toThrow(/shadows an existing "book" column/);
  });

  it("db.get without an addon → row shape unchanged", () => {
    const q = query({
      verb: "GET",
      apiGroup: group,
      name: "q9",
      stack: [s.db.get({ table: book, fieldValue: c.int(1), as: "row" })],
      response: ref("row"),
    });
    expectTypeOf(q).toBeObject();
    expectTypeOf<InferResponse<typeof q>>().toEqualTypeOf<Book>();
  });
});
