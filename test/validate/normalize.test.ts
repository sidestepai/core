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

  it("leaves a numeric paging offset untouched", () => {
    // `offset` is also a number under a list context's paging block. Only the
    // empty-string form is an addon-splice default.
    expect(normalize({ paging: { offset: 0, page: 1 } })).toEqual({ paging: { offset: 0, page: 1 } });
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

  it("drops an expression group that nests nothing", () => {
    expect(normalize({ group: { expression: [] } })).toEqual({});
    expect(normalize({ group: { expression: [] } })).toEqual(normalize({}));
  });

  it("preserves a group that actually nests expressions", () => {
    const nested = { group: { expression: [{ type: "statement", statement: { op: "=" } }] } };
    expect(normalize(nested)).toEqual(nested);
    expect(normalize(nested)).not.toEqual(normalize({ group: { expression: [] } }));
  });

  it("does not touch an aggregate's empty group array", () => {
    // `group` is also a sort/grouping LIST under an aggregate return. Only the
    // nested-search object form is a condition default.
    expect(normalize({ aggregate: { group: [] } })).toEqual({ aggregate: { group: [] } });
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
