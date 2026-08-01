/**
 * U3: lock the shared `sidestep validate` normalizer against a real persisted
 * TABLE (`dbo`) golden. The full compiled↔golden table parity is proven in
 * test/fields/catalog.test.ts and test/kinds/table.test.ts; this pins the
 * validate-path normalizer specifically — that it strips the server keys a live
 * readback carries while preserving authored schema data, with no new strip
 * rules required for tables.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalize } from "../../src/validate/normalize.js";
import { encodeApiGroup } from "../../src/kinds/api-group.js";

function loadTable(name: string): Record<string, unknown> {
  const url = new URL(`../fixtures/tables/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as Record<string, unknown>;
}

describe("validate normalizer — table (dbo) readback", () => {
  it("strips server/deploy keys a live export carries", () => {
    const normalized = normalize(loadTable("schema-table.json")) as Record<string, unknown>;
    for (const key of ["id", "created_at", "updated_at", "guid", "workspace", "market_item"]) {
      expect(normalized[key]).toBeUndefined();
    }
    // A table returns nothing (no `as`) — the isTable branch drops it on both sides.
    expect(normalized["as"]).toBeUndefined();
  });

  it("preserves authored schema data through normalization", () => {
    const normalized = normalize(loadTable("schema-table.json")) as { name?: unknown; schema?: unknown };
    expect(normalized.name).toBe("user");
    expect(Array.isArray(normalized.schema)).toBe(true);
    expect((normalized.schema as unknown[]).length).toBeGreaterThan(0);
  });

  it("keeps a non-default authored value (sensitive column) intact", () => {
    const table = loadTable("schema-table-sensitive.json");
    const normalized = normalize(table) as { schema?: Array<Record<string, unknown>> };
    const rawSensitive = (table.schema as Array<Record<string, unknown>>).some((c) => c.sensitive === true);
    const normSensitive = (normalized.schema ?? []).some((c) => c.sensitive === true);
    // If the golden marks any column sensitive, normalize must not swallow it.
    expect(normSensitive).toBe(rawSensitive);
  });

  it("is idempotent (normalizing twice equals normalizing once)", () => {
    const once = normalize(loadTable("schema-table-fancy.json"));
    const twice = normalize(once);
    expect(twice).toEqual(once);
  });
});

/**
 * Per-kind rules the whole-object kind corpus (test/conformance/kinds-corpus.test.ts)
 * required — each is a Branch A serialization/server-default artifact. Every rule
 * is tested on BOTH sides: it drops/coerces at the engine default, and it
 * PRESERVES a customized value so the byte-fidelity oracle stays honest.
 */
describe("validate normalizer — per-kind default/serialization rules", () => {
  it("canonicalizes the two persisted timestamp serializations to one instant", () => {
    const iso = normalize({ starts_on: "2026-01-01T00:00:00Z" }) as { starts_on: string };
    const pg = normalize({ starts_on: "2026-01-01 00:00:00+0000" }) as { starts_on: string };
    expect(iso.starts_on).toBe(pg.starts_on);
    expect(iso.starts_on).toBe("2026-01-01T00:00:00.000Z");
    // A non-timestamp string is untouched.
    expect(normalize({ v: "hello world" })).toEqual({ v: "hello world" });
  });

  it("drops a numeric trigger obj_id (branch ref) but keeps a guid-string obj_id", () => {
    expect(normalize({ obj_id: 1 })).toEqual({});
    expect(normalize({ obj_id: 0 })).toEqual({});
    const guid = "157d4a98d979cf04b9ccdb98dfc15229";
    expect(normalize({ obj_id: guid })).toEqual({ obj_id: guid });
  });

  it("drops engine-recorded run history, which is telemetry rather than settings", () => {
    // A task that has run carries `history` as an ARRAY of past runs. The
    // generated tree deliberately does not carry it, so the comparison must not
    // report that omission as a failed round trip too.
    expect(normalize({ history: [{ on: "2022-01-14 23:16:11+0000", duration: 0.16 }] })).toEqual({});
    expect(normalize({ history: [] })).toEqual({});
  });

  it("drops an inheriting history block but keeps a customized one", () => {
    expect(normalize({ history: { inherit: true, tool_limit: 100, tool_enabled: true } })).toEqual({});
    const custom = { history: { inherit: false, limit: 5, enabled: true } };
    expect(normalize(custom)).toEqual(custom);
  });

  it("applies the same inherit drop/preserve to container-tier history shapes", () => {
    // API group (query_*) and toolset (tool_*) carry `inherit`, so the same rule
    // drops the inheriting default and preserves an authored override.
    expect(normalize({ history: { inherit: true, query_enabled: true, query_limit: 100 } })).toEqual({});
    const app = { history: { inherit: false, query_enabled: false, query_limit: 100 } };
    expect(normalize(app)).toEqual(app);
    const toolset = { history: { inherit: false, tool_enabled: true, tool_limit: -1 } };
    expect(normalize(toolset)).toEqual(toolset);
  });

  it("drops null agent_settings and a disabled telemetry block", () => {
    expect(normalize({ agent_settings: null })).toEqual({});
    expect(normalize({ telemetry: { enabled: false, langfuse: { api_key: "" } } })).toEqual({});
    const on = { telemetry: { enabled: true, destination: "langfuse" } };
    expect(normalize(on)).toEqual(on);
  });

  it("drops an empty test list and a default auth:false, keeps auth:true", () => {
    expect(normalize({ test: [] })).toEqual({});
    expect(normalize({ auth: false })).toEqual({});
    expect(normalize({ auth: true })).toEqual({ auth: true });
  });

  it("drops the engine-default db-query context members, keeps customized ones", () => {
    const defaultContext = {
      bind: [],
      eval: [],
      sort: [],
      future: false,
      lock: { tag: "const:bool", value: "", filters: [] },
      search: { expression: [] },
      external: {
        tag: "input",
        value: "",
        filters: [],
        permissions: { page: true, sort: true, search: true, per_page: false },
      },
    };
    // Every listed member is an engine default → the object normalizes to empty.
    expect(normalize(defaultContext)).toEqual({});
    // A customized member (non-empty sort, lock set) survives.
    const custom = { sort: [{ by: "name" }], future: true };
    expect(normalize(custom)).toEqual(custom);
  });
});

/**
 * U2: the engine writes `input:null` / `output:null` for a statement that takes no
 * inputs or shapes no result, while the SDK emits the full envelope (`input:[]`
 * and `{items:[],filters:[],customize:false}`). Both spell the same empty state,
 * so the comparison has to treat them as equal — otherwise every input-less
 * statement in a pulled workspace fails its re-encode proof and degrades to
 * `raw()`, which was the single largest cause in the codegen sweep.
 *
 * Each rule is tested on BOTH sides: it collapses at the empty spellings, and it
 * PRESERVES a populated value. The negative half is what keeps the rule from
 * quietly weakening what `sidestep validate` reports to a user.
 */
describe("validate normalizer — null vs empty envelope spellings", () => {
  it("treats input null, [] and absent as the same empty state", () => {
    expect(normalize({ input: null })).toEqual({});
    expect(normalize({ input: [] })).toEqual({});
    expect(normalize({ name: "mvp:uuid4", input: null })).toEqual(
      normalize({ name: "mvp:uuid4", input: [] }),
    );
  });

  it("preserves a populated input rather than collapsing it", () => {
    const populated = { input: [{ name: "id", value: "1", tag: "const" }] };
    expect(normalize(populated)).toEqual(populated);
    // The rule must not make a populated input compare equal to an empty one.
    expect(normalize(populated)).not.toEqual(normalize({ input: null }));
  });

  it("treats output null and both empty forms as the same empty state", () => {
    expect(normalize({ output: null })).toEqual({});
    expect(normalize({ output: { filters: [] } })).toEqual({});
    expect(normalize({ output: { items: [], filters: [], customize: false } })).toEqual({});
    expect(normalize({ output: null })).toEqual(
      normalize({ output: { items: [], filters: [], customize: false } }),
    );
  });

  it("preserves an output carrying selected items", () => {
    // A kept `output` keeps its members verbatim — only the empty `children` of a
    // selected item is elided. The selection itself must survive.
    const selected = { output: { items: [{ name: "id", children: [] }], customize: false } };
    expect(normalize(selected)).toEqual({ output: { items: [{ name: "id" }], customize: false } });
    expect(normalize(selected)).not.toEqual(normalize({ output: null }));
  });

  it("preserves an output that customizes, even with no items", () => {
    const customized = { output: { items: [], filters: [], customize: true } };
    expect(normalize(customized)).toEqual({ output: { items: [], customize: true } });
    expect(normalize(customized)).not.toEqual(normalize({ output: null }));
  });

  it("collapses a null-envelope statement to the same shape as a full-envelope one", () => {
    // The engine's lean spelling and the SDK's full spelling of one statement.
    const stored = { name: "mvp:uuid4", as: "id", input: null, output: null, disabled: true };
    const encoded = {
      name: "mvp:uuid4",
      as: "id",
      input: [],
      output: { items: [], filters: [], customize: false },
      disabled: true,
      description: "",
      addon: [],
      mocks: {},
      runtime: null,
      settings_registry: null,
      _xsid: "",
    };
    expect(normalize(encoded)).toEqual(normalize(stored));
    // `disabled:true` is authored state, not an envelope default — it survives both.
    expect((normalize(stored) as { disabled?: unknown }).disabled).toBe(true);
  });

  it("is idempotent over the null spellings", () => {
    const once = normalize({ input: null, output: null, name: "mvp:uuid4" });
    expect(normalize(once)).toEqual(once);
  });
});

/**
 * U3: two more empty-vs-absent spellings. An empty `context` arrives as a JSON
 * array from the engine and an object from the SDK — an empty associative
 * collection serializes as `[]`. An addon spliced at the root persists
 * `offset:""` where the SDK omits it.
 *
 * Both are tested on both sides. The `context` coercion in particular has to stay
 * scoped: a blanket array→object rule would corrupt every genuinely-empty list in
 * the envelope, so that negative case is explicit below.
 */
describe("validate normalizer — empty context and addon offset", () => {
  it("treats an empty context as the same state whether array or object", () => {
    expect(normalize({ context: [] })).toEqual({ context: {} });
    expect(normalize({ context: [] })).toEqual(normalize({ context: {} }));
  });

  it("preserves a populated context rather than collapsing it", () => {
    // `id` is deliberately absent here — it is a stripped server key, so it would
    // not survive normalization and would not prove anything about this rule.
    const populated = { context: { dbo: { as: "user" }, future: true } };
    expect(normalize(populated)).toEqual(populated);
    expect(normalize(populated)).not.toEqual(normalize({ context: [] }));
  });

  it("still normalizes the members of a populated context", () => {
    // The coercion must not short-circuit recursion: `bind:[]` is an engine
    // default and still has to drop from inside a kept context.
    expect(normalize({ context: { bind: [], dbo: { as: "user" } } })).toEqual({
      context: { dbo: { as: "user" } },
    });
  });

  it("does not coerce an empty array outside the context slot", () => {
    // The rule is scoped by key. Any other empty list stays a list.
    expect(normalize({ schema: [], items: [] })).toEqual({ schema: [], items: [] });
    expect(normalize({ addon: [] })).toEqual({}); // dropped by its own rule, not coerced
  });

  it("treats an empty addon offset as absent, and keeps a real one", () => {
    expect(normalize({ offset: "" })).toEqual({});
    expect(normalize({ offset: "items[]" })).toEqual({ offset: "items[]" });
  });

  it("drops a paging offset at its declared default but keeps a real one", () => {
    // `offset` is two unrelated things: an addon's splice path (`""` at the root)
    // and a list context's paging offset, which the engine declares to default to
    // 0. Both are defaults; a real offset is preserved.
    expect(normalize({ paging: { offset: 0, page: 1 } })).toEqual({});
    expect(normalize({ paging: { offset: 40 } })).toEqual({ paging: { offset: 40 } });
    // The addon ENTRY still exists — only its default offset drops.
    expect(normalize({ addon: [{ offset: "" }] })).toEqual({ addon: [{}] });
  });

  it("collapses an addon spliced at the root to match the SDK's omission", () => {
    const stored = { addon: [{ as: "user", offset: "", input: null }] };
    const encoded = { addon: [{ as: "user", input: [] }] };
    expect(normalize(encoded)).toEqual(normalize(stored));
  });
});

/**
 * U4: per-statement `context` defaults. Unlike the empty-collection rules above,
 * these are values the SDK writes at a default the persisted form omits — each one
 * checked against the engine's own declared default for that member before being
 * frozen here, because a guessed default would make a real authored value
 * invisible to the round-trip diff.
 */
describe("validate normalizer — per-statement context defaults", () => {
  it("drops an all-defaults return block in either spelling", () => {
    // The lean spelling: result type at its default, no sub-block customized.
    expect(normalize({ return: { type: "list" } })).toEqual({});
    // The expanded spelling the engine fills on save was already handled.
    expect(normalize({ return: { type: "list" } })).toEqual(
      normalize({
        return: {
          list: {
            sort: [],
            paging: { page: 1, offset: 0, totals: false, enabled: false, metadata: true, per_page: 25 },
            distinct: "auto",
          },
          type: "list",
          single: { sort: [] },
          stream: { sort: [], paging: { page: 1, enabled: false, per_page: 25 }, distinct: "auto" },
          aggregate: { eval: [], sort: [], group: [], index: [], paging: { page: 1, enabled: false, metadata: true, per_page: 25 } },
        },
      }),
    );
  });

  it("preserves a non-default result type and customized paging", () => {
    expect(normalize({ return: { type: "single" } })).toEqual({ return: { type: "single" } });
    expect(normalize({ return: { type: "count" } })).not.toEqual(normalize({ return: { type: "list" } }));
    const paged = { return: { type: "list", list: { paging: { enabled: true, per_page: 100 } } } };
    expect(normalize(paged)).toEqual(paged);
  });

  it("drops a default sibling result-shape block beside a customized one", () => {
    // The engine writes all four result-shape blocks on every query; the SDK writes
    // only the one its `returnType` selects. Emptiness alone did not collapse a
    // default sibling, because two of its members have no rule that empties them
    // (the paging `enabled` gate and an aggregate's empty `group`/`index` lists),
    // so one customized member left every sibling mismatching. Measured on the
    // sweep, `context.return` was implicated in ALL 174 remaining `db.query`
    // mismatches and was the sole cause in 87.
    const engine = {
      return: {
        type: "list",
        list: { sort: [], paging: { page: 1, enabled: true, per_page: 10 }, distinct: "auto" },
        single: { sort: [] },
        stream: { sort: [], paging: { page: 1, enabled: false, per_page: 25 }, distinct: "auto" },
        aggregate: {
          eval: [], sort: [], group: [], index: [],
          paging: { page: 1, enabled: false, metadata: true, per_page: 25 },
        },
      },
    };
    // The three default siblings go; the customized `list` block stays, with its
    // customization intact.
    expect(normalize(engine)).toEqual({
      return: { type: "list", list: { paging: { enabled: true, per_page: 10 } } },
    });
  });

  it("drops a CUSTOMIZED sibling block too — only the branch `type` names is live", () => {
    // The stronger half of the rule. A default sibling collapsing is not enough:
    // the editor's return panel is one form group over the whole section and
    // emits all four blocks on save, so a query that was a paged list before its
    // type was switched to `single` keeps that list block forever — sort, paging
    // and all. Nothing reads it: the converter that builds the engine's query
    // config is a chain of `if (returnType == "…")` arms, each touching only its
    // own branch, and Xano's own XanoScript translator writes only the live one.
    const switched = {
      return: {
        type: "single",
        single: { sort: [] },
        list: {
          sort: [{ sortBy: "post.created_at", orderBy: "desc" }],
          paging: { page: 1, enabled: true, per_page: 10, metadata: true, totals: false, offset: 0 },
          distinct: "auto",
        },
      },
    };
    expect(normalize(switched)).toEqual({ return: { type: "single" } });
    // …and it compares equal to the same query with no leftover at all, which is
    // the point: the SDK writes the second and the editor stores the first.
    expect(normalize(switched)).toEqual(normalize({ return: { type: "single" } }));
  });

  it("keeps the LIVE block when a sibling is dropped, and drops nothing on a lone branch", () => {
    // The paired negative — the rule must not be able to eat the branch that runs.
    const live = {
      return: {
        type: "aggregate",
        aggregate: { group: [{ name: "posts.author_id", as: "author" }] },
        list: { sort: [{ sortBy: "posts.id", orderBy: "desc" }] },
      },
    };
    expect(normalize(live)).toEqual({
      return: { type: "aggregate", aggregate: { group: [{ name: "posts.author_id", as: "author" }] } },
    });
    // A section carrying only its live branch is left exactly alone.
    const lone = { return: { type: "list", list: { sort: [{ sortBy: "a.id", orderBy: "asc" }] } } };
    expect(normalize(lone)).toEqual(lone);
    // And `return` is not a licence to strip these names anywhere else — a `list`
    // beside a `type` elsewhere in the envelope is untouched.
    const loose = { type: "single", list: { sort: [{ sortBy: "a.id", orderBy: "asc" }] } };
    expect(normalize(loose)).toEqual(loose);
  });

  it("preserves a result-shape block that is actually customized", () => {
    // The load-bearing negatives: the rule compares against each block's own frozen
    // default, so anything authored inside one still compares unequal.
    const grouped = {
      aggregate: {
        group: [{ name: "posts.author_id", as: "author" }], eval: [], sort: [], index: [],
        paging: { page: 1, enabled: false, metadata: true, per_page: 25 },
      },
    };
    expect(normalize(grouped)).not.toEqual(normalize({}));
    expect(JSON.stringify(normalize(grouped))).toContain("author_id");

    const stream = { stream: { sort: [], paging: { page: 2, enabled: true, per_page: 5 }, distinct: "auto" } };
    expect(normalize(stream)).toEqual({ stream: { paging: { page: 2, enabled: true, per_page: 5 } } });

    const single = { single: { sort: [{ sortBy: "id", orderBy: "desc" }] } };
    expect(normalize(single)).toEqual(single);
  });

  it("does not touch a foreach's iterated list value", () => {
    // `list` is a generic member name, and comparing against the frozen return
    // sub-default rather than testing for emptiness is what keeps this rule off it:
    // an iterated list is a tagged value and cannot match the default block.
    // (The empty `filters` drops by its own long-standing rule — what matters here
    // is that the `list` MEMBER survives rather than being swept up as a default.)
    expect(normalize({ list: { tag: "input", value: "rows", filters: [] } })).toEqual({
      list: { tag: "input", value: "rows" },
    });
    expect(normalize({ list: [] })).toEqual({ list: [] });
  });

  it("drops an expression group that nests nothing", () => {
    expect(normalize({ group: { expression: [] } })).toEqual({});
    expect(normalize({ group: { expression: [] } })).toEqual(normalize({}));
  });

  it("preserves a group that actually nests expressions", () => {
    const nested = { group: { expression: [{ type: "statement", statement: { op: "=" } }] } };
    expect(normalize(nested)).toEqual(nested);
    expect(normalize(nested)).not.toEqual(normalize({ group: { expression: [] } }));
  });

  it("does not touch an empty group array", () => {
    // `group` is also a sort/grouping LIST under an aggregate return. Only the
    // nested-search object form is a condition default.
    //
    // Asserted bare rather than under `aggregate`: once a disabled all-default
    // paging block collapses, `{group: []}` IS the whole normalized default
    // aggregate block, so wrapping it tested block collapse rather than this.
    expect(normalize({ group: [] })).toEqual({ group: [] });
    // Still a real grouping list when it holds anything.
    expect(normalize({ aggregate: { group: [{ name: "x" }] } })).toEqual({
      aggregate: { group: [{ name: "x" }] },
    });
  });

  it("drops a default-false or-flag and keeps a real one", () => {
    expect(normalize({ or: false })).toEqual({});
    expect(normalize({ or: true })).toEqual({ or: true });
  });

  it("drops default-public asset access and keeps private", () => {
    expect(normalize({ access: "public" })).toEqual({});
    expect(normalize({ access: "private" })).toEqual({ access: "private" });
    expect(normalize({ access: "internal" })).toEqual({ access: "internal" });
  });

  it("collapses a full condition entry to its persisted-lean twin", () => {
    const stored = {
      expression: [{ type: "statement", statement: { op: "=", left: { operand: "a" } } }],
    };
    const encoded = {
      expression: [
        {
          type: "statement",
          or: false,
          group: { expression: [] },
          statement: { op: "=", left: { operand: "a", filters: [] } },
        },
      ],
    };
    expect(normalize(encoded)).toEqual(normalize(stored));
  });
});

/**
 * The return block's paging members, each at the default the engine declares for
 * it. Two things make these safe to drop by key name: the drop is symmetric (a
 * customized value is preserved and still compared), and the same-named members of
 * a permissions block are booleans, so they are type-distinct and untouched.
 *
 * A persisted int can arrive as a numeric string, so both forms count as the
 * default — a real readback carries `per_page: "25"` as readily as `25`.
 */
describe("validate normalizer — return-block paging defaults", () => {
  it("collapses an all-defaults paging block", () => {
    expect(
      normalize({ paging: { page: 1, offset: 0, totals: false, metadata: true, per_page: 25 } }),
    ).toEqual({});
  });

  it("accepts the numeric-string spelling of each default", () => {
    expect(normalize({ paging: { page: "1", offset: "0", per_page: "25" } })).toEqual({});
  });

  it("reads an absent paging block and a switched-off one as the same thing", () => {
    // The SDK writes `paging:{enabled:false}` whenever nothing was authored; 7
    // real db.query statements omit the key entirely against 149 storing it
    // present-at-default. Every engine consumer reads the flag as
    // `["paging"]["enabled"] ?? false`, and the serializer emits nothing for a
    // disabled block — so absent IS disabled.
    expect(normalize({ paging: { enabled: false } })).toEqual({});
    expect(normalize({ paging: { enabled: false } })).toEqual(normalize({}));
    expect(
      normalize({ paging: { page: 1, offset: 0, totals: false, enabled: false, metadata: true, per_page: 25 } }),
    ).toEqual({});
  });

  it("clears a LOCAL table reference inside customize, on both sides of the comparison", () => {
    // The decoder rewrites these to unbound; normalize applies the SAME rewrite
    // so that deliberate change does not also read as a failed round trip.
    const withLocal = { customize: { c: { methods: [{ name: "@", arg: ["dbo=14"] }] } } };
    const unbound = { customize: { c: { methods: [{ name: "@", arg: ["dbo="] }] } } };
    expect(normalize(withLocal)).toEqual(normalize(unbound));
  });

  it("keeps a guid-form reference inside customize, and every reference outside one", () => {
    const guid = "1111000000000000000000000000aaaa";
    expect(
      normalize({ customize: { c: { methods: [{ name: "@", arg: [`dbo=${guid}`] }] } } }),
    ).toEqual({ customize: { c: { methods: [{ name: "@", arg: [`dbo=${guid}`] }] } } });
    // A numeric reference at FIELD level is a different, already-settled case:
    // it stays verbatim and decodes to raw() rather than being rewritten here.
    expect(normalize({ methods: [{ name: "@", arg: ["dbo=14"] }] })).toEqual({
      methods: [{ name: "@", arg: ["dbo=14"] }],
    });
  });

  it("drops setheader's duplicate mode at the value the engine reads from an absent key", () => {
    // Declared `duplicates?=replace` and read as `($data["duplicates"] ?? "replace")`;
    // 3 real statements omit it against 8 storing it present-at-default.
    expect(normalize({ duplicates: "replace" })).toEqual({});
    expect(normalize({ duplicates: "append" })).toEqual({ duplicates: "append" });
  });

  it("reads an unbound simpleExternal scaffold through BOTH stored spellings", () => {
    // The editor writes all five facets on a query that binds none of them, and
    // spells the blank two ways — 61 as `input`, 3 as `const`. Both bind the
    // same nothing. Read as authored they became five bound paging Values, and
    // since the SDK refuses to author `external` alongside input-bound paging,
    // the recovered call THREW and took the whole db.query to raw().
    const blank = (tag: string) =>
      Object.fromEntries(
        ["page", "sort", "offset", "search", "per_page"].map((k) => [k, { tag, value: "", filters: [] }]),
      );
    expect(normalize({ simpleExternal: blank("input") })).toEqual({});
    expect(normalize({ simpleExternal: blank("const") })).toEqual({});
  });

  it("keeps a simpleExternal that binds any facet at all", () => {
    // Asserted on the normalized form — an empty `filters` list drops here for
    // unrelated reasons. What matters is that the block SURVIVES.
    expect(
      normalize({
        simpleExternal: {
          page: { tag: "input", value: "page", filters: [] },
          per_page: { tag: "input", value: "per_page", filters: [] },
        },
      }),
    ).toEqual({
      simpleExternal: { page: { tag: "input", value: "page" }, per_page: { tag: "input", value: "per_page" } },
    });
    // One real facet among blanks is still authored.
    expect(
      normalize({
        simpleExternal: {
          page: { tag: "const", value: "", filters: [] },
          offset: { tag: "const:int", value: "12", filters: [] },
        },
      }),
    ).toEqual({
      simpleExternal: { page: { tag: "const", value: "" }, offset: { tag: "const:int", value: "12" } },
    });
  });

  it("keeps a switched-off paging block that still customizes something", () => {
    // The narrowness that makes the rule safe: it fires only once every OTHER
    // member has normalized away. A disabled block holding a real `per_page` is
    // not the same as no block at all.
    expect(normalize({ paging: { enabled: false, per_page: 50 } })).toEqual({
      paging: { enabled: false, per_page: 50 },
    });
    expect(normalize({ paging: { enabled: true } })).toEqual({ paging: { enabled: true } });
  });

  it("still treats enabled:false as meaningful outside a paging block", () => {
    // `enabled` cannot be dropped by name — it gates a history block, where
    // false is the authored value, not an absence.
    expect(normalize({ history: { enabled: false } })).toEqual({ history: { enabled: false } });
  });

  it("preserves every customized paging member", () => {
    expect(normalize({ paging: { per_page: 10 } })).toEqual({ paging: { per_page: 10 } });
    expect(normalize({ paging: { page: 3 } })).toEqual({ paging: { page: 3 } });
    expect(normalize({ paging: { totals: true } })).toEqual({ paging: { totals: true } });
    expect(normalize({ paging: { metadata: false } })).toEqual({ paging: { metadata: false } });
  });

  it("keeps a numeric-string customized value, canonicalized to its declared int", () => {
    // The bug this came from: a stored `per_page: "10"` was skipped as "not a
    // number" and the re-encode fell back to 25. What matters is that a customized
    // value SURVIVES — it must not drop as a default and must not read as 25.
    //
    // It canonicalizes to the number rather than staying a string because that is
    // what the member declares (`int`), and the two serializations are the same
    // value: a stored `"10"` against an encoded `10` was costing 11 real `db.query`
    // statements their readability. Compare against the default to prove the point
    // of the original bug still holds.
    expect(normalize({ paging: { per_page: "10" } })).toEqual({ paging: { per_page: 10 } });
    expect(normalize({ paging: { per_page: "10" } })).not.toEqual(normalize({ paging: {} }));
    expect(normalize({ paging: { per_page: "10" } })).toEqual(normalize({ paging: { per_page: 10 } }));
    // The default-holding form still drops in either serialization — and the block
    // it empties then drops too, by the `paging` rule.
    expect(normalize({ paging: { per_page: "25" } })).toEqual({});
    expect(normalize({ paging: { per_page: 25 } })).toEqual({});
  });

  it("leaves an addon's offset path alone while coercing a paging offset", () => {
    // `offset` names two unrelated things. An addon's is a response PATH, which is
    // not a numeric string and so cannot be swept into the int coercion.
    expect(normalize({ offset: "items[]" })).toEqual({ offset: "items[]" });
    expect(normalize({ paging: { offset: "40" } })).toEqual({ paging: { offset: 40 } });
  });

  it("drops a default distinct and keeps an explicit one", () => {
    expect(normalize({ distinct: "auto" })).toEqual({});
    expect(normalize({ distinct: "yes" })).toEqual({ distinct: "yes" });
  });

  it("leaves a permissions block's same-named boolean members alone", () => {
    // `page`/`per_page` are booleans here, so the numeric-default rules cannot
    // reach them.
    const permissions = { permissions: { page: true, sort: true, search: true, per_page: false } };
    expect(normalize(permissions)).toEqual(permissions);
  });
});

/**
 * A comparison's operands are tagged values under a different key, and the corpus
 * serializes a `const:int` there as a number or a string interchangeably.
 *
 * This one was a silent hole rather than a missing nicety, which is why it has
 * its own block. The statement decoders hand `prove` the STORED value object as
 * the factory argument, so a re-encode reproduces whatever the workspace stored
 * and the proof passes — while the source those decoders emit says `c.int(0)`,
 * which encodes `"0"`. The proof could not see a difference that a real
 * re-export does, and 5 queries reported a round-trip mismatch because of it.
 */
describe("validate normalizer — comparison operand serialization", () => {
  it("coerces a numeric operand to its string form, like a tagged `value`", () => {
    expect(normalize({ right: { tag: "const:int", operand: 0, filters: [] } })).toEqual(
      normalize({ right: { tag: "const:int", operand: "0", filters: [] } }),
    );
  });

  it("still compares operands that genuinely differ", () => {
    // The paired negative: equalizing the SPELLING must not equalize the VALUE.
    expect(normalize({ right: { tag: "const:int", operand: 0 } })).not.toEqual(
      normalize({ right: { tag: "const:int", operand: 1 } })
    );
    expect(normalize({ left: { tag: "input", operand: "a" } })).not.toEqual(
      normalize({ left: { tag: "input", operand: "b" } })
    );
  });

  it("leaves a non-numeric operand exactly as stored", () => {
    // (An empty `filters` drops by its own pre-existing rule; the operand itself
    // is what this pins.)
    expect(normalize({ left: { tag: "var", operand: "api_1.response.status", filters: [] } })).toEqual(
      { left: { tag: "var", operand: "api_1.response.status" } },
    );
  });
});

/**
 * Object-level default envelope members — the kind-level twin of the statement
 * rules above, and the largest single cause of round-trip mismatches in a real
 * sweep (1,716 of 1,744 rows, once mismatches started naming their keys).
 *
 * Same generational gap, one level up: an object saved by an older engine
 * generation omits these keys entirely, while both the current engine and the
 * SDK always write them at a fixed default. Every default below is evidenced
 * twice — the engine reads the absent key as this value, and real workspaces
 * store the key present-at-this-value and absent side by side on the same
 * instance.
 *
 * Every rule is paired with a negative: it drops at the default and PRESERVES
 * anything authored, so no rule can quietly equalize two different objects.
 */
describe("validate normalizer — object-level default envelope members", () => {
  it("drops a query's default response_type, which the engine reads from an absent key", () => {
    expect(normalize({ name: "q", response_type: "standard" })).toEqual({ name: "q" });
  });

  it("keeps a response_type that selects a different behavior", () => {
    expect(normalize({ name: "q", response_type: "stream" })).toEqual({
      name: "q",
      response_type: "stream",
    });
  });

  it("drops the empty documentation strings an object carries at rest", () => {
    expect(normalize({ docs: "", view_alias: "", datasource: "" })).toEqual({});
    expect(normalize({ docs: "written", datasource: "warm" })).toEqual({
      docs: "written",
      datasource: "warm",
    });
  });

  it("drops the empty list members, and only when they are empty", () => {
    expect(normalize({ tag: [], views: [], result: [] })).toEqual({});
    expect(normalize({ tag: [{ tag: "billing" }] })).toEqual({ tag: [{ tag: "billing" }] });
    expect(normalize({ result: [{ name: "x" }] })).toEqual({ result: [{ name: "x" }] });
  });

  it("never touches the `tag` that DISCRIMINATES a tagged value", () => {
    // The load-bearing negative for the empty-list rule: `tag` is the most
    // common key in a workspace because every tagged value carries one. There
    // it is a STRING, so the rule is type-distinct — but a rule on that name
    // has to prove it, not assert it.
    expect(normalize({ tag: "const:str", value: "hi" })).toEqual({ tag: "const:str", value: "hi" });
    expect(normalize({ tag: "input", value: "user_id" })).toEqual({ tag: "input", value: "user_id" });
  });

  it("drops the two group gates at the value the engine reads from an absent key", () => {
    // Opposite defaults, and each is what the engine falls back to: a group is
    // enabled unless it says otherwise, and docs are off unless turned on.
    expect(normalize({ api_group_enabled: true, swagger: false })).toEqual({});
    expect(normalize({ api_group_enabled: false, swagger: true })).toEqual({
      api_group_enabled: false,
      swagger: true,
    });
  });

  it("drops a default documentation block, and keeps one holding a token", () => {
    expect(normalize({ documentation: { require_token: false, token: "" } })).toEqual({});
    const authored = { documentation: { require_token: true, token: "C6UYpWv" } };
    expect(normalize(authored)).toEqual(authored);
  });

  it("drops a default CORS block, and keeps a configured one", () => {
    const empty = {
      mode: "default",
      allowOrigins: [],
      allowHeaders: [],
      allowCredentials: false,
      maxAge: 0,
      allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false },
    };
    expect(normalize({ cors: empty })).toEqual({});
    const configured = { cors: { ...empty, mode: "custom", maxAge: 3600, allowOrigins: ["x.test"] } };
    expect(normalize(configured)).toEqual(configured);
  });

  it("reads the LEGACY cors spelling as the same default block", () => {
    // Two real API groups store a block that predates `mode` and spells "off" as
    // `enabled: false`. The engine applies a CORS block only when its `mode` is
    // `"custom"` — reading an absent mode as `""` — so a block with no mode is
    // inert, exactly like `mode: "default"`. `enabled` is not a key that handler
    // reads at all.
    const legacy = {
      cors: {
        maxAge: 0,
        enabled: false,
        allowHeaders: [],
        allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false },
        allowOrigins: [],
        allowCredentials: false,
      },
    };
    expect(normalize(legacy)).toEqual({});
  });

  it("does not let the legacy spelling swallow a CUSTOM cors block", () => {
    const custom = {
      cors: {
        mode: "custom",
        enabled: false,
        maxAge: 3600,
        allowHeaders: [],
        allowMethods: { delete: false, get: true, head: false, patch: false, post: true, put: false },
        allowOrigins: ["www.google.com"],
        allowCredentials: true,
      },
    };
    expect(normalize(custom)).toEqual(custom);
  });

  it("reads an empty middleware block through BOTH of its stored spellings", () => {
    // The empty-associative-collection artifact again (`mocks`, `customize`, an
    // empty `context`): the engine hands an empty map back as a JSON array,
    // while the SDK writes the members out. 173 real API groups store `[]` and
    // 85 store the object — same "no middleware" either way.
    expect(normalize({ middleware: [] })).toEqual({});
    expect(
      normalize({ middleware: { pre: [], post: [], pre_customize: false, post_customize: false } }),
    ).toEqual({});
  });

  it("drops a phase list the customize flag switches OFF, on both sides", () => {
    // The engine's resolver reads a phase list ONLY when its `_customize` flag
    // is set; otherwise it falls through to the parent tier without looking at
    // the list at all. So an editor leftover in `pre` behind `pre_customize:
    // false` is inert, and the SDK's empty `pre` is the same state — two real
    // API groups differed by exactly this.
    const leftover = {
      middleware: { pre: [{ name: "mvp:middleware" }], post: [], pre_customize: false, post_customize: true },
    };
    const empty = { middleware: { pre: [], post: [], pre_customize: false, post_customize: true } };
    expect(normalize(leftover)).toEqual(normalize(empty));
  });

  it("keeps a phase list the customize flag switches ON", () => {
    // The paired negative, and the one that matters: a CUSTOMIZED phase is what
    // the engine actually runs, so its entries must still compare.
    const one = { middleware: { pre: [{ name: "mvp:middleware" }], post: [], pre_customize: true, post_customize: false } };
    const none = { middleware: { pre: [], post: [], pre_customize: true, post_customize: false } };
    expect(normalize(one)).not.toEqual(normalize(none));
  });

  it("does not treat a lookalike object as a middleware block", () => {
    // `pre`/`post` are generic names; the rule only applies where a
    // `_customize` flag says this is a middleware block.
    const other = { pre: ["a"], post: ["b"] };
    expect(normalize(other)).toEqual(other);
  });

  it("keeps a middleware block that attaches or customizes anything", () => {
    // The customized phase survives with its entries; the inert one drops.
    const attached = { middleware: { pre: [{ name: "mvp:middleware" }], post: [], pre_customize: true, post_customize: false } };
    expect(normalize(attached)).toEqual({
      middleware: { pre: [{ name: "mvp:middleware" }], pre_customize: true, post_customize: false },
    });
    // A phase explicitly customized to run NOTHING is not the same as
    // inheriting — the engine reads that empty list and runs nothing, where an
    // inheriting phase would run the parent tier's chain. So `pre: clear()`
    // stays distinguishable from an absent phase.
    const cleared = { middleware: { pre: [], post: [], pre_customize: true, post_customize: false } };
    expect(normalize(cleared)).toEqual({
      middleware: { pre: [], pre_customize: true, post_customize: false },
    });
    expect(normalize(cleared)).not.toEqual(normalize(attached));
  });
});

/**
 * The frozen defaults in the normalizer are literals, because that module sits
 * UNDER the authoring layer and cannot import an encoder. This is what stops
 * the two drifting apart: an encoder default that changes without the matching
 * literal would silently start reporting every API group as a mismatch again.
 */
describe("validate normalizer — the frozen object defaults match the encoder", () => {
  it("collapses an all-default API group to nothing but its identity", () => {
    const encoded = encodeApiGroup({ name: "public" }) as unknown as Record<string, unknown>;
    // Everything the encoder writes unconditionally is a default; only the
    // name and the history block (its own rules) survive.
    const normalized = normalize(encoded) as Record<string, unknown>;
    for (const key of ["swagger", "api_group_enabled", "docs", "documentation", "middleware", "tag", "cors"]) {
      expect(normalized[key], `${key} is written at its default and must drop`).toBeUndefined();
    }
    expect(normalized["name"]).toBe("public");
  });

  it("still reports an API group that configures any of them", () => {
    const plain = normalize(encodeApiGroup({ name: "public" }));
    for (const def of [
      { name: "public", swagger: true },
      { name: "public", apiGroupEnabled: false },
      { name: "public", docs: "how to use" },
      { name: "public", documentation: { require_token: true, token: "t" } },
      { name: "public", tags: ["billing"] },
      { name: "public", cors: { mode: "custom" as const, maxAge: 3600 } },
    ]) {
      expect(normalize(encodeApiGroup(def)), `${JSON.stringify(def)} must not collapse`).not.toEqual(plain);
    }
  });
});

/**
 * The empty spellings a stored object uses for "nothing here", one key at a
 * time. Same generational gap as the block above, and the same discipline: each
 * key is evidenced in the 177-workspace corpus storing the empty form and the
 * ABSENT form side by side on one instance, and each rule is paired with a
 * negative that keeps an authored value comparing.
 */
describe("validate normalizer — per-key empty spellings", () => {
  it("drops an MCP tool entry's default type and its empty metadata", () => {
    // 8 real tool entries store `type:"tool"` with empty metadata and 1 omits
    // all three. A tool that exposes a RESOURCE says so, and still compares.
    expect(normalize({ type: "tool", tool_meta: "", resource_uri: "" })).toEqual({});
    expect(normalize({ type: "resource", resource_uri: "file://x" })).toEqual({
      type: "resource",
      resource_uri: "file://x",
    });
  });

  it("leaves the `type` discriminators that are not a tool kind", () => {
    // The paired negative for a generic name: `type` also discriminates
    // expression nodes and column types, and none of those spell "tool".
    expect(normalize({ type: "group" })).toEqual({ type: "group" });
    expect(normalize({ type: "text" })).toEqual({ type: "text" });
  });

  it("drops the empty agent provider-config members", () => {
    expect(
      normalize({ baseURL: "", headers: "", safetySettings: "", dynamicRetrievalConfig: "", apiKey: "" }),
    ).toEqual({});
    const set = { baseURL: "https://x.test", apiKey: "{{ $env.gemini }}" };
    expect(normalize(set)).toEqual(set);
  });

  it("never mistakes an api_request header LIST for the empty spelling", () => {
    // `headers` is a string[] on an api_request statement; only the empty-STRING
    // spelling an agent config uses is dropped.
    expect(normalize({ headers: [] })).toEqual({ headers: [] });
    expect(normalize({ headers: ["A: 1"] })).toEqual({ headers: ["A: 1"] });
  });

  it("reads every stored spelling of an unset thinking config as unset", () => {
    // Four spellings across 16 real configs — `""`, absent, and the block with
    // its budget as either `0` or `""`. The SDK writes the last one.
    for (const v of ["", { includeThoughts: false, thinkingBudget: 0 }, { includeThoughts: false, thinkingBudget: "" }]) {
      expect(normalize({ thinkingConfig: v }), JSON.stringify(v)).toEqual({});
    }
    const budgeted = { thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } };
    expect(normalize(budgeted)).toEqual(budgeted);
  });

  it("reads an empty auth string as the same no-auth that `false` means", () => {
    expect(normalize({ auth: "" })).toEqual({});
    const table = { auth: "6QkKbIDe6DVBwUj4gv4HKSdRT1A" };
    expect(normalize(table)).toEqual(table);
  });

  it("drops an empty view alias but keeps a named one", () => {
    expect(normalize({ alias: "" })).toEqual({});
    expect(normalize({ alias: "superseanview" })).toEqual({ alias: "superseanview" });
  });

  it("strips a query `example` whole, because its contents are USER data", () => {
    // Not emptied — stripped. An example payload is a saved request/response
    // SAMPLE, so a key inside it named `output` or `input` means whatever the
    // user meant, not what a statement envelope means. Normalizing into it
    // rewrote one real 700-byte sample down to `{}` by applying the
    // statement-output rule to the user's own `output` key.
    expect(normalize({ example: { output: { float: 3.14 }, input: { abc: 123 } } })).toEqual({});
    expect(normalize({ example: {} })).toEqual({});
  });

  it("strips a query's saved `test` list, which nothing models", () => {
    // Reported as an omission by the decoder, so it must NOT also read as a
    // failed round trip — an omission and a mismatch mean opposite things.
    const tests = [
      { id: "0373fad8", name: "test", input: [], token: "", expect: [{ type: "to_equal", vars: [] }] },
    ];
    expect(normalize({ test: tests })).toEqual({});
  });

  it("keys the `test` strip on shape, never on that very generic name", () => {
    // Real workspaces hold table columns named `test`/`test2` and const values
    // "test". Stripping every key called `test` would delete user data.
    expect(normalize({ test: "a string" })).toEqual({ test: "a string" });
    expect(normalize({ test: { name: "not a list" } })).toEqual({ test: { name: "not a list" } });
    // An array, but not of test definitions — no `expect` on the entries.
    expect(normalize({ test: [{ name: "col" }] })).toEqual({ test: [{ name: "col" }] });
    // A column literally named `test` survives untouched.
    expect(normalize({ name: "test", type: "text" })).toEqual({ name: "test", type: "text" });
  });
});

describe("validate normalizer — an unset async runtime binding", () => {
  it("reads both stored spellings of 'no runtime' as unset", () => {
    // `null` on one engine generation, blank members on another — 6 real
    // `mvp:function` statements store `{id: "", mode: ""}`.
    expect(normalize({ runtime: null })).toEqual({});
    expect(normalize({ runtime: { id: "", mode: "" } })).toEqual({});
  });

  it("keeps a runtime binding that names something", () => {
    // `id` is a stripped server column everywhere, including inside `runtime`,
    // so what survives is the part the comparison actually judges.
    expect(normalize({ runtime: { id: "worker-1", mode: "async" } })).toEqual({
      runtime: { mode: "async" },
    });
    // A partially-set binding is still authored data.
    expect(normalize({ runtime: { id: "", mode: "async" } })).toEqual({
      runtime: { mode: "async" },
    });
  });
});

/**
 * Statements whose `input[]` the engine reads BY NAME, so stored order is inert.
 *
 * Real workspaces store the same entries in more than one order — 3
 * `api_request` hoist `verify_host`/`verify_peer` to the front, and one each of
 * the two document statements permute theirs. Every statement on the list was
 * checked against the engine handler, which indexes its arguments by name
 * by NAME rather than by position, so a reordering cannot change what it does.
 */
describe("validate normalizer — name-keyed input ordering", () => {
  const entry = (name: string) => ({ name, tag: "const", value: name, filters: [] });

  it("compares a permuted api_request input as equal", () => {
    const a = { name: "mvp:api_request", input: [entry("url"), entry("method"), entry("verify_peer")] };
    const b = { name: "mvp:api_request", input: [entry("verify_peer"), entry("url"), entry("method")] };
    expect(normalize(a)).toEqual(normalize(b));
  });

  it("applies to both document statements too", () => {
    for (const name of ["mvp:amazon_opensearch_document", "mvp:elasticsearch_document"]) {
      const a = { name, input: [entry("base_url"), entry("method"), entry("index")] };
      const b = { name, input: [entry("method"), entry("index"), entry("base_url")] };
      expect(normalize(a), name).toEqual(normalize(b));
    }
  });

  it("still compares the VALUES, not just the names", () => {
    // Equalizing the ORDER must not equalize the content.
    const a = { name: "mvp:api_request", input: [entry("url"), { ...entry("method"), value: "GET" }] };
    const b = { name: "mvp:api_request", input: [entry("url"), { ...entry("method"), value: "POST" }] };
    expect(normalize(a)).not.toEqual(normalize(b));
  });

  it("does NOT reorder a statement whose input order is meaningful", () => {
    // The load-bearing negative. A lookup's `input[]` has to lead with
    // `field_name`/`field_value`, and a row write's columns are positional —
    // sorting either would silently change what the statement does.
    const lead = { name: "mvp:dbo_getby", input: [entry("field_name"), entry("field_value"), entry("z")] };
    const moved = { name: "mvp:dbo_getby", input: [entry("z"), entry("field_name"), entry("field_value")] };
    expect(normalize(lead)).not.toEqual(normalize(moved));
  });
});

/**
 * A REQUIRED input's `default` — an unreachable member with two spellings.
 *
 * `convertSchemaParamToConfig` opens with, unconditionally:
 *
 *     if ($param["required"]) { $param["default"] = null; $param["hasDefault"] = false; }
 *
 * so on a required input the stored `default` is discarded before anything reads
 * it. Both spellings occur in the wild — `""` from the engine's own trigger
 * templates and from this SDK, `null` from whatever wrote the realtime triggers
 * on a current instance — and a live sweep found 82 `.input[].default` mismatch
 * rows, every one of them a required entry.
 *
 * The scope is the whole finding. The next lines of that same function are
 * `$param["default"] ??= ""` and a nullable branch that sets `null`, so on an
 * OPTIONAL input the two spellings can genuinely differ.
 */
describe("validate normalizer — a required input's inert default", () => {
  const entry = (over: Record<string, unknown>) => ({
    input: [{ name: "action", type: "enum", required: true, default: "", ...over }],
  });

  it("reads `null` and `\"\"` as one state on a required input", () => {
    expect(normalize(entry({ default: null }))).toEqual(normalize(entry({ default: "" })));
  });

  it("reads them as one state on an OPTIONAL input too", () => {
    // The optional branch does not discard the default, but it still converges
    // the two spellings: `$param["default"] ??= ""` turns a stored null into "",
    // and the nullable branch then turns "" back into null. Either way both
    // arrive at the same value.
    for (const over of [{ required: false, nullable: true }, { required: false, nullable: false }]) {
      expect(normalize(entry({ ...over, default: null }))).toEqual(
        normalize(entry({ ...over, default: "" })),
      );
    }
  });

  it("still preserves a REAL default on an optional input", () => {
    // The line that stops the rule becoming "defaults do not exist". Only null
    // and "" converge; `"pre"` is an authored value and must survive.
    const withValue = normalize(entry({ required: false, default: "pre" })) as {
      input: Array<Record<string, unknown>>;
    };
    expect(withValue.input[0]!["default"]).toBe("pre");
    expect(normalize(entry({ required: false, default: "pre" }))).not.toEqual(
      normalize(entry({ required: false, default: "" })),
    );
  });

  it("applies to an obj input's children, which convert recursively", () => {
    const child = (d: unknown) => ({
      input: [
        {
          name: "client",
          type: "obj",
          required: true,
          default: "",
          children: [{ name: "permissions", type: "obj", required: true, default: d }],
        },
      ],
    });
    expect(normalize(child(null))).toEqual(normalize(child("")));
  });

  it("leaves a statement's input[] entries alone", () => {
    // A statement's `input[]` is `{name, tag, value}` — no `type`/`required`, so
    // it must pass straight through rather than acquire a `default`.
    const stmt = { input: [{ name: "dbtable", tag: "const", value: "x", filters: [] }] };
    const entry0 = (normalize(stmt) as { input: Array<Record<string, unknown>> }).input[0]!;
    expect(entry0).not.toHaveProperty("default");
    expect(entry0).toMatchObject({ name: "dbtable", tag: "const", value: "x" });
  });

  it("treats a table COLUMN the same way, because the engine does", () => {
    // `convertSchemaParamsToConfig($dbo, $params)` runs a table's columns through
    // the very same function, so a REQUIRED column's default is discarded too.
    // Two real workspaces store the two spellings on the same required columns —
    // `id`/`name` as `"0"`/`""` in one and `null` in the other.
    const table = (d: unknown) => ({ schema: [{ name: "id", type: "int", required: true, default: d }] });
    expect(normalize(table(null))).toEqual(normalize(table("0")));
  });

  it("KEEPS an optional column's default, which is the point of the check", () => {
    // `created_at` defaulting to `now` is real and must survive. This is the
    // assertion that stops the rule above becoming "columns have no defaults".
    const table = { schema: [{ name: "created_at", type: "epochms", required: false, default: "now" }] };
    expect((normalize(table) as typeof table).schema[0]!.default).toBe("now");
  });
});
