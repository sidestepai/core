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
