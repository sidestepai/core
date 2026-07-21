/**
 * `db.query` (`mvp:dbo_view`) emit-shape proof (issues #41 / #34 / #36).
 *
 * These fixtures are DERIVED FROM SOURCE, not captured goldens — there is no
 * vendored `dbo_view` golden in the corpus. The shape is grounded in the
 * cloud-client MVP schema + converter that the live engine reads:
 *   - context.search {expression[]}  ← MVP/xs/type/mvp/{Search,Expression,Statement}.php
 *   - context.return.list.{sort,paging}  ← MVP/xs/type/mvp/ReturnSection.php +
 *     helper/MVP.php::convertContextToConfig (top-level `context.sort` is NEVER read)
 *   - context.lock {value,tag,filters}  ← MVP/xs/type/mvp/Context.php + convertLockToConfig
 *   - statement `output` envelope  ← the db.get `query-auth-me` golden
 * Behavior is verified end-to-end by the live cross-user repro (issue #41).
 *
 * The bug these lock down: `dbQuery` used to emit the filter under `context.where`
 * — a key the engine never reads — so every filtered read returned the whole
 * table (a cross-user data leak, #41). Sort/paging were likewise mis-keyed (#34/#36).
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register kinds + statements
import { dbQuery } from "../../src/statements/special/db.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { c, col, auth, inp } from "../../src/values/value.js";
import { expr } from "../../src/statements/conditional.js";
import { normalize, loadFixture } from "../conformance/harness.js";

const note = table({
  name: "note",
  schema: { user_id: f.int(), title: f.text(), body: f.text() },
});

/** Deep-equal a built dbo_view against a derived fixture, with the table id aligned to the guid. */
function expectShape(fixtureName: string, built: ReturnType<typeof encodeStatement>) {
  const fixture = loadFixture(`statements/${fixtureName}.json`) as {
    _derived_from?: string;
    context: { dbo: { id: unknown } };
  };
  delete fixture._derived_from; // in-file provenance note, not part of the emit
  fixture.context.dbo.id = deriveGuid("dbo", note.name);
  expect(normalize(built)).toEqual(normalize(fixture));
}

describe("db.query (mvp:dbo_view) emit shape", () => {
  it("filter-only query — filter under context.search, list return, no legacy keys (#41)", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, where: expr(col("user_id"), "=", auth("id")), as: "rows" }),
    );
    expectShape("db_view_where", enc);
    // Guard the exact regression: the old (ignored) key must be gone.
    expect(enc.context).not.toHaveProperty("where");
  });

  it("full query — where + additionalWhere + sort + paging + output + lock", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        where: expr(col("user_id"), "=", auth("id")),
        additionalWhere: expr(col("title"), "!=", c.text("")),
        sort: [{ sortBy: "created_at", dir: "desc" }],
        paging: { per_page: 25, totals: true },
        output: ["id", "title"],
        lock: true,
        as: "rows",
      }),
    );
    expectShape("db_view_where_sort_paging_output", enc);
  });

  it("where + additionalWhere fold into one ANDed expression (no additional_where key)", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        where: expr(col("user_id"), "=", auth("id")),
        additionalWhere: expr(col("title"), "!=", c.text("")),
      }),
    );
    const search = (enc.context as { search: { expression: unknown[] } }).search;
    expect(search.expression).toHaveLength(2);
    expect(enc.context).not.toHaveProperty("additional_where");
  });

  it("sort maps dir → engine orderBy under context.return.list.sort", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, sort: [{ sortBy: "title" }, { sortBy: "user_id", dir: "rand" }] }),
    );
    const ret = (enc.context as { return: { list: { sort: { sortBy: string; orderBy: string }[] } } })
      .return.list.sort;
    expect(ret).toEqual([
      { sortBy: "title", orderBy: "asc" }, // dir defaults to asc
      { sortBy: "user_id", orderBy: "rand" },
    ]);
    expect(enc.context).not.toHaveProperty("sort");
  });

  it("paging lands under context.return.list.paging with enabled:true (#36)", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, paging: { page: 2, per_page: 10, offset: 5, metadata: false } }),
    );
    const paging = (enc.context as { return: { list: { paging: Record<string, unknown> } } })
      .return.list.paging;
    expect(paging).toEqual({
      enabled: true,
      page: 2,
      per_page: 10,
      offset: 5,
      metadata: false,
      totals: false,
    });
    expect(enc.context).not.toHaveProperty("paging");
  });

  it("no paging → return.list.paging disabled", () => {
    const enc = encodeStatement(dbQuery({ table: note }));
    const paging = (enc.context as { return: { list: { paging: { enabled: boolean } } } })
      .return.list.paging;
    expect(paging.enabled).toBe(false);
  });

  // --- Input-bound paging (issue #66) ---

  it("input-bound page → context.simpleExternal.page tagged value; static block stays the gate", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, paging: { page: inp("page"), per_page: 20 }, as: "rows" }),
    );
    expectShape("db_view_simple_external", enc);
  });

  it("a Value paging field forces enabled:true (the engine gate) with the static default baseline", () => {
    const enc = encodeStatement(dbQuery({ table: note, paging: { page: inp("page") } }));
    const { paging } = (enc.context as { return: { list: { paging: Record<string, unknown> } } })
      .return.list;
    expect(paging.enabled).toBe(true);
    expect(paging.page).toBe(1); // static baseline; the Value overrides at runtime
    expect((enc.context as { simpleExternal: { page: unknown } }).simpleExternal.page).toEqual({
      value: "page",
      tag: "input",
      filters: [],
    });
  });

  it("input-bound offset rides simpleExternal.offset, keeps the static default", () => {
    const enc = encodeStatement(dbQuery({ table: note, paging: { offset: inp("off") } }));
    expect((enc.context as { simpleExternal: { offset: unknown } }).simpleExternal.offset).toEqual({
      value: "off",
      tag: "input",
      filters: [],
    });
  });

  it("search/sort-only paging does NOT activate pagination (enabled stays false, no truncation)", () => {
    const enc = encodeStatement(dbQuery({ table: note, paging: { search: inp("q"), sort: inp("s") } }));
    const ctx = enc.context as {
      return: { list: { paging: { enabled: boolean } } };
      simpleExternal: { search: unknown; sort: unknown };
    };
    expect(ctx.return.list.paging.enabled).toBe(false); // no page field → no default pagination
    expect(ctx.simpleExternal.search).toEqual({ value: "q", tag: "input", filters: [] });
    expect(ctx.simpleExternal.sort).toEqual({ value: "s", tag: "input", filters: [] });
  });

  it("all-static paging emits no simpleExternal (byte-identical to today)", () => {
    const enc = encodeStatement(dbQuery({ table: note, paging: { page: 2, per_page: 10 } }));
    expect(enc.context).not.toHaveProperty("simpleExternal");
  });

  it("output columns ride the statement output envelope, not context.output", () => {
    const enc = encodeStatement(dbQuery({ table: note, output: ["id", "title"] }));
    expect((enc.output as { customize: boolean }).customize).toBe(true);
    expect((enc.output as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
      "id",
      "title",
    ]);
    expect(enc.context).not.toHaveProperty("output");
  });

  it("no output → full-record default (customize:false)", () => {
    const enc = encodeStatement(dbQuery({ table: note }));
    expect((enc.output as { customize: boolean }).customize).toBe(false);
  });

  it("lock emits a tagged bool value, not a bare boolean", () => {
    const enc = encodeStatement(dbQuery({ table: note, lock: true }));
    expect((enc.context as { lock: unknown }).lock).toEqual({
      value: "true",
      tag: "const:bool",
      filters: [],
    });
  });

  it("a raw Value where passes through under context.search", () => {
    const enc = encodeStatement(dbQuery({ table: note, where: c.text("id > 0") }));
    expect((enc.context as { search: unknown }).search).toEqual(c.text("id > 0"));
    expect(enc.context).not.toHaveProperty("where");
  });

  it("rejects mixing a raw Value where with expr() clauses", () => {
    expect(() =>
      dbQuery({
        table: note,
        where: c.text("id > 0"),
        additionalWhere: expr(col("user_id"), "=", auth("id")),
      }),
    ).toThrow(/raw Value/);
  });
});
