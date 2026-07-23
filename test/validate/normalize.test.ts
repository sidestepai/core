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
