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
import { c, col, auth, inp, ref, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { expr } from "../../src/statements/conditional.js";
import { cmp, and, or } from "../../src/statements/special/db-search.js";
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

  it("a query that configures nothing emits a bare return, as Xano's editor does", () => {
    // `mvp_return`'s `list` sub-block is optional, and the engine's own editor
    // writes `{type:"list"}` for a query with no sort/paging/distinct. Emitting
    // the block filled with defaults is behaviourally identical but is not the
    // shape a pulled workspace carries — and round-tripping one is the point.
    const enc = encodeStatement(dbQuery({ table: note }));
    expect((enc.context as { return: unknown }).return).toEqual({ type: "list" });
  });

  it("keeps the full list block whenever paging is authored at all", () => {
    // The block is the engine's gate for simpleExternal (#66) and for the
    // search/sort-only no-truncation rule (#41), so passing `paging` — even
    // all-default — must not drop it.
    const enc = encodeStatement(dbQuery({ table: note, paging: {} }));
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

  it("an explicit paging.enabled overrides the derivation, in both directions", () => {
    // Added so a decoder can reproduce a stored query that carries a non-default
    // `per_page` with the gate OFF — real workspaces persist exactly that, and a
    // derive-only encoder could not express it. It is an override, not a new
    // default: every derivation assertion above is unchanged.
    const off = encodeStatement(dbQuery({ table: note, paging: { per_page: 10, enabled: false } }));
    const offPaging = (off.context as { return: { list: { paging: { enabled: boolean; per_page: number } } } })
      .return.list.paging;
    expect(offPaging.enabled).toBe(false); // derivation would have said true
    expect(offPaging.per_page).toBe(10); // and the value it gates still persists

    const on = encodeStatement(dbQuery({ table: note, paging: { search: inp("q"), enabled: true } }));
    const onPaging = (on.context as { return: { list: { paging: { enabled: boolean } } } })
      .return.list.paging;
    expect(onPaging.enabled).toBe(true); // derivation would have said false (#41)
  });

  it("the gate and the addon graft offset stay consistent under an override", () => {
    // The gate also decides whether rows sit under `items[]`, so the two read the
    // same value — a query whose gate is forced off must not graft addons into a
    // paging envelope that will not exist.
    const enc = encodeStatement(
      dbQuery({
        table: note,
        paging: { per_page: 10, enabled: false },
        addon: [{ addon: { name: "author", guid: "3333000000000000000000000000cccc" }, as: "_author" }],
      }),
    );
    const [attached] = (enc as { addon: Array<{ offset?: string; as: string }> }).addon;
    // No envelope, so no `items[]` prefix — the offset is simply absent, which is
    // the same state as the `""` a pulled workspace carries (normalize drops both).
    expect(attached?.offset).not.toBe("items[]");
    expect(attached?.as).toBe("_author");

    // And with the gate left to derive, the same addon DOES graft under the envelope.
    const derived = encodeStatement(
      dbQuery({
        table: note,
        paging: { per_page: 10 },
        addon: [{ addon: { name: "author", guid: "3333000000000000000000000000cccc" }, as: "_author" }],
      }),
    );
    expect((derived as { addon: Array<{ offset?: string }> }).addon[0]?.offset).toBe("items[]");
  });

  it("all-static paging emits no simpleExternal (byte-identical to today)", () => {
    const enc = encodeStatement(dbQuery({ table: note, paging: { page: 2, per_page: 10 } }));
    expect(enc.context).not.toHaveProperty("simpleExternal");
  });

  // --- Classic external blob (U2) ---

  it("external blob → context.external with permissions; forces paging.enabled:true", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        external: { value: inp("filters"), permissions: { page: true, search: true } },
        as: "rows",
      }),
    );
    expectShape("db_view_external", enc);
  });

  it("external with no paging arg still forces enabled:true so page/per_page take effect", () => {
    const enc = encodeStatement(dbQuery({ table: note, external: { value: inp("x") } }));
    const { paging } = (enc.context as { return: { list: { paging: { enabled: boolean } } } })
      .return.list;
    expect(paging.enabled).toBe(true);
  });

  it("external + all-static paging is allowed and emits both blocks (no simpleExternal)", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, paging: { per_page: 50 }, external: { value: inp("x") } }),
    );
    expect((enc.context as { external: unknown }).external).toBeDefined();
    expect(enc.context).not.toHaveProperty("simpleExternal");
  });

  it("rejects external combined with an input-bound paging field (mutual exclusion)", () => {
    expect(() =>
      dbQuery({ table: note, paging: { page: inp("page") }, external: { value: inp("x") } }),
    ).toThrow(/mutually exclusive/);
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

  // --- Extended operators + nested groups (M2: U4/U5) ---

  it("cmp() supports the extended operator set (in/like/overlaps/@>/...)", () => {
    const enc = encodeStatement(dbQuery({ table: note, where: cmp(col("title"), "ilike", inp("q")) }));
    const stmt = (
      enc.context as {
        search: { expression: { statement: { op: string; left: unknown; right: unknown } }[] };
      }
    ).search.expression[0]!.statement;
    expect(stmt.op).toBe("ilike");
    expect(stmt.left).toEqual({ operand: "title", tag: "col", filters: [] });
    expect(stmt.right).toEqual({ operand: "q", tag: "input", filters: [] });
  });

  it("cmp() ignoreEmpty sets right.ignore_empty; default omits it", () => {
    const withFlag = encodeStatement(
      dbQuery({ table: note, where: cmp(col("title"), "=", inp("q"), { ignoreEmpty: true }) }),
    );
    const withoutFlag = encodeStatement(dbQuery({ table: note, where: cmp(col("title"), "=", inp("q")) }));
    const r1 = (withFlag.context as { search: { expression: { statement: { right: Record<string, unknown> } }[] } })
      .search.expression[0]!.statement.right;
    const r2 = (withoutFlag.context as { search: { expression: { statement: { right: Record<string, unknown> } }[] } })
      .search.expression[0]!.statement.right;
    expect(r1.ignore_empty).toBe(true);
    expect(r2).not.toHaveProperty("ignore_empty");
  });

  it("cmp() rejects an unsupported operator at authoring time", () => {
    // @ts-expect-error — "like?" is not a SearchOp
    expect(() => cmp(col("title"), "like?", inp("q"))).toThrow(/unsupported operator/);
  });

  // #118 re-verified fixed: an inline filtered search operand imports, round-trips,
  // AND runs on a live engine (left/right/no-arg/with-arg all pass — see
  // examples/sandbox/_capture-search.ts). The blanket rejection is gone; the
  // separate filter-NAME resolvability check still catches genuinely-bad filters
  // at export. Filtered operands now pass through inline, like conditionals.
  it("a filtered value in the right operand passes through inline (#118 fixed)", () => {
    const filtered = withFilters(inp("status"), fl.first_notempty(c.text("%")));
    const enc = encodeStatement(dbQuery({ table: note, where: cmp(col("status"), "ilike", filtered) }));
    const right = ((enc.context as any).search.expression[0]).statement.right;
    expect(right.operand).toBe("status");
    expect(right.tag).toBe("input");
    expect(right.filters).toHaveLength(1);
    expect(right.filters[0].name).toBe("first_notempty");
  });

  it("a filtered value in the left operand passes through inline (#118 fixed)", () => {
    const filtered = withFilters(col("title"), fl.trim());
    const enc = encodeStatement(dbQuery({ table: note, where: cmp(filtered, "=", c.text("x")) }));
    const left = ((enc.context as any).search.expression[0]).statement.left;
    expect(left.operand).toBe("title");
    expect(left.filters[0].name).toBe("trim");
  });

  it("a filtered operand in a narrow expr() clause passes through inline (#118 fixed)", () => {
    const filtered = withFilters(inp("status"), fl.first_notempty(c.text("%")));
    const enc = encodeStatement(dbQuery({ table: note, where: expr(col("status"), "=", filtered) }));
    const right = ((enc.context as any).search.expression[0]).statement.right;
    expect(right.filters[0].name).toBe("first_notempty");
  });

  it("the set_var + ref() operand form (a readability option, not a requirement) encodes fine (#118)", () => {
    const enc = encodeStatement(dbQuery({ table: note, where: cmp(col("status"), "ilike", ref("pat")) }));
    const stmt = (
      enc.context as { search: { expression: { statement: { right: unknown } }[] } }
    ).search.expression[0]!.statement;
    expect(stmt.right).toEqual({ operand: "pat", tag: "var", filters: [] });
  });

  // #145: the reported trap was `c.now()` used inline as a `where` operand —
  // pitched as "compiles but fails at export (#120)". That no longer reproduces:
  // it exports cleanly through the FULL workspace export (not just
  // encodeStatement). This locks that in at the export layer so the stale "hoist
  // first" claim can't creep back. (`c.now()` is no longer even a filtered value
  // — it emits the engine's native `const:epochms` constant.)
  it("c.now() inline as a where operand exports cleanly through full export() (#145)", async () => {
    const { Xano, query, apiGroup } = await import("../../src/index.js");
    const grp = apiGroup({ name: "g", canonical: "abc123" });
    const q = query({
      name: "recent",
      verb: "GET",
      apiGroup: grp,
      stack: [dbQuery({ table: note, where: expr(col("created_at"), ">", c.now()), as: "rows" })],
      response: ref("rows"),
    });
    const bundle = new Xano()
      .registerApiGroups([grp])
      .registerTables([note])
      .registerQueries([q])
      .export();
    // Export did not throw, and the current-time constant is in the emitted bundle.
    expect(JSON.stringify(bundle)).toContain("const:epochms");
  });

  it("a ROOT or() joins the root siblings flat, rather than wrapping them", () => {
    // This shape changed deliberately (R-D). A root `or(...)` used to emit one
    // group node wrapping both children — a form that, across 187 real
    // workspaces, the engine stores exactly ZERO times: the editor writes root
    // siblings flat, with the join on the sibling.
    //
    // It changes emitted bytes for an authoring form that already ships, so it
    // was proven on a live engine before landing rather than argued offline: the
    // two spellings select the same rows and take the same branch across the
    // whole truth table of a two-term OR, in a query's search block and in a
    // runtime conditional alike, and the flat form survives an export unchanged.
    const enc = encodeStatement(
      dbQuery({
        table: note,
        where: or(expr(col("user_id"), "=", auth("id")), cmp(col("title"), "ilike", inp("q"))),
      }),
    );
    const top = (enc.context as { search: { expression: { type: string; or: boolean }[] } })
      .search.expression;
    expect(top).toHaveLength(2);
    expect(top[0]!.type).toBe("statement");
    expect(top[0]!.or).toBe(false); // the first sibling never ORs to a nonexistent predecessor
    expect(top[1]!.or).toBe(true); // the second ORs to the first
  });

  it("keeps a group wrapped when the root holds more than one node", () => {
    // The paired negative: root siblings are ANDed, so a group sitting beside
    // another node must keep its wrapper or its own join would be lost.
    const enc = encodeStatement(
      dbQuery({
        table: note,
        where: [
          expr(col("user_id"), "=", auth("id")),
          or(cmp(col("title"), "ilike", inp("q")), expr(col("title"), "=", c.text("x"))),
        ],
      }),
    );
    const top = (enc.context as { search: { expression: { type: string; or: boolean }[] } })
      .search.expression;
    expect(top).toHaveLength(2);
    expect(top[1]!.type).toBe("group");
    expect(top[1]!.or).toBe(false); // ANDed against its sibling
  });

  it("nested and(a, or(b, c)) emits a group containing a nested group", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        where: and(
          expr(col("user_id"), "=", auth("id")),
          or(cmp(col("title"), "ilike", inp("q")), expr(col("title"), "=", c.text("x"))),
        ),
      }),
    );
    const top = (enc.context as { search: { expression: { type: string; group: { expression: { type: string }[] } }[] } })
      .search.expression;
    expect(top[0]!.type).toBe("group");
    const kids = top[0]!.group.expression;
    expect(kids[0]!.type).toBe("statement");
    expect(kids[1]!.type).toBe("group"); // the nested or(...)
  });

  it("flat where: [expr, expr] stays ANDed (or:false) — back-compat", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        where: [expr(col("user_id"), "=", auth("id")), expr(col("title"), "!=", c.text(""))],
      }),
    );
    const top = (enc.context as { search: { expression: { or: boolean; type: string }[] } })
      .search.expression;
    expect(top).toHaveLength(2);
    expect(top.every((n) => n.or === false && n.type === "statement")).toBe(true);
  });

  // --- Return types (M3: U6) ---

  const ret = (enc: ReturnType<typeof encodeStatement>): unknown =>
    (enc.context as { return: unknown }).return;

  it("returnType count/exists → bare { type }, no sub-block", () => {
    expect(ret(encodeStatement(dbQuery({ table: note, returnType: "count" })))).toEqual({ type: "count" });
    expect(ret(encodeStatement(dbQuery({ table: note, returnType: "exists" })))).toEqual({ type: "exists" });
  });

  it("returnType single → { type:'single', single:{ sort } }, no paging", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, returnType: "single", sort: [{ sortBy: "id", dir: "desc" }] }),
    );
    expect(ret(enc)).toEqual({ type: "single", single: { sort: [{ sortBy: "id", orderBy: "desc" }] } });
  });

  it("returnType stream → sort + distinct, no metadata/totals; paging is {page,per_page,enabled}", () => {
    const noPaging = encodeStatement(dbQuery({ table: note, returnType: "stream" }));
    expect(ret(noPaging)).toEqual({ type: "stream", stream: { sort: [], distinct: "auto" } });
    const paged = encodeStatement(
      dbQuery({ table: note, returnType: "stream", paging: { page: 1, per_page: 10 } }),
    );
    expect(ret(paged)).toEqual({
      type: "stream",
      stream: { sort: [], distinct: "auto", paging: { page: 1, per_page: 10, enabled: true } },
    });
  });

  it("default returnType is list (byte-identical to today)", () => {
    const a = ret(encodeStatement(dbQuery({ table: note })));
    const b = ret(encodeStatement(dbQuery({ table: note, returnType: "list" })));
    expect(a).toEqual(b);
    expect((a as { type: string }).type).toBe("list");
  });

  // --- distinct + eval (M4: U7/U8) ---

  it("distinct rides return.list.distinct (default auto)", () => {
    const yes = ret(encodeStatement(dbQuery({ table: note, distinct: "yes" })));
    expect((yes as { list: { distinct: string } }).list.distinct).toBe("yes");
    // `auto` is the engine default, so a query that sets nothing omits the whole
    // block rather than restating it — same meaning, Xano's own shape.
    const auto = ret(encodeStatement(dbQuery({ table: note })));
    expect(auto).toEqual({ type: "list" });
  });

  it("distinct on a stream query rides return.stream.distinct", () => {
    const enc = ret(encodeStatement(dbQuery({ table: note, returnType: "stream", distinct: "no" })));
    expect((enc as { stream: { distinct: string } }).stream.distinct).toBe("no");
  });

  it("eval computed columns emit context.eval[] {as,name,filters}", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        eval: [
          { name: "title", as: "title_calc", filters: [{ name: "upper", disabled: true }, { name: "trim" }] },
        ],
      }),
    );
    expect((enc.context as { eval: unknown[] }).eval).toEqual([
      {
        as: "title_calc",
        name: "title",
        filters: [
          { name: "upper", arg: [], disabled: true },
          { name: "trim", arg: [] },
        ],
      },
    ]);
  });

  it("eval filter arg values encode to tagged {value,tag,filters}", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, eval: [{ name: "user_id", as: "uid_plus", filters: [{ name: "add", arg: [c.int(1)] }] }] }),
    );
    const arg = (enc.context as { eval: { filters: { arg: unknown[] }[] }[] }).eval[0]!.filters[0]!.arg;
    expect(arg).toEqual([{ value: "1", tag: "const:int", filters: [] }]);
  });

  it("eval alias shadowing an existing column throws", () => {
    expect(() => dbQuery({ table: note, eval: [{ name: "user_id", as: "title" }] })).toThrow(/shadows/);
  });

  // --- Aggregate / group-by (M5: U9) ---

  it("returnType aggregate emits context.return.aggregate {sort,paging,eval,group}", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        returnType: "aggregate",
        aggregate: {
          group: [{ name: "user_id", as: "uid" }],
          eval: [{ name: "id", as: "cnt", filters: [{ name: "count" }] }],
          sort: [{ sortBy: "uid" }],
          paging: { per_page: 50 },
        },
      }),
    );
    // group/eval column names are alias-qualified with the table name — the
    // engine rejects a bare (dotless) column in an aggregate ("Unsupported param
    // format - <col>"). The author writes bare names; the SDK qualifies them.
    expect(ret(enc)).toEqual({
      type: "aggregate",
      aggregate: {
        sort: [{ sortBy: "uid", orderBy: "asc" }],
        eval: [{ as: "cnt", name: "note.id", filters: [{ name: "count", arg: [] }] }],
        group: [{ as: "uid", name: "note.user_id", filters: [] }],
        paging: { page: 1, per_page: 50, metadata: true, enabled: true },
      },
    });
  });

  it("aggregate passes an author-qualified (dotted) name through unchanged", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        returnType: "aggregate",
        // a `bind`ed/joined column the author already qualified — do not re-prefix
        aggregate: { group: [{ name: "author.name", as: "author_name" }] },
      }),
    );
    expect((ret(enc) as { aggregate: { group: { name: string }[] } }).aggregate.group[0]!.name).toBe(
      "author.name",
    );
  });

  it("aggregate throws at export when a dotted name is malformed (engine would reject)", () => {
    // A name the author dotted but left malformed (trailing dot → empty column)
    // passes through qualification but is not a real `<alias>.<column>`. Fail loud
    // at export, not 500 at runtime.
    expect(() =>
      encodeStatement(
        dbQuery({ table: note, returnType: "aggregate", aggregate: { group: [{ name: "note.", as: "x" }] } }),
      ),
    ).toThrow(/alias-qualified/);
  });

  it("aggregate without paging omits the paging block", () => {
    const enc = encodeStatement(
      dbQuery({ table: note, returnType: "aggregate", aggregate: { group: [{ name: "user_id", as: "uid" }] } }),
    );
    expect((ret(enc) as { aggregate: Record<string, unknown> }).aggregate).not.toHaveProperty("paging");
  });

  // --- Joins (M6: U11) ---

  it("bind with a where emits {dbo:{as,id}, join, search}", () => {
    const enc = encodeStatement(
      dbQuery({
        table: note,
        bind: [{ table: note, as: "note2", join: "left", where: cmp(col("note.user_id"), "=", col("note2.user_id")) }],
      }),
    );
    const bind = (enc.context as { bind: { dbo: { as: string; id: unknown }; join: string; search: { expression: unknown[] } }[] }).bind;
    expect(bind[0]!.dbo.as).toBe("note2");
    expect(bind[0]!.join).toBe("left");
    expect(bind[0]!.search.expression).toHaveLength(1);
  });

  it("bind defaults join to inner and as to the table name; no where → no search key", () => {
    const enc = encodeStatement(dbQuery({ table: note, bind: [{ table: note }] }));
    const bind = (enc.context as { bind: { dbo: { as: string }; join: string }[] }).bind;
    expect(bind[0]!.join).toBe("inner");
    expect(bind[0]!.dbo.as).toBe("note");
    expect(bind[0]).not.toHaveProperty("search");
  });

  it("two binds resolving to the same alias throw", () => {
    expect(() => dbQuery({ table: note, bind: [{ table: note }, { table: note }] })).toThrow(/duplicate join alias/);
  });
});
