import { describe, it, expect } from "vitest";
// Import through the public entry so every object kind (incl. workspace-config)
// is registered before `workspace()` runs.
import { workspace, table, f } from "../../src/index.js";
import { emitBundle } from "../../src/emit/emit.js";
import { buildSeedContentFiles } from "../../src/workspace/seed.js";

/**
 * U5 / R4 — frontend-isolation guard. Seed VALUES must never enter the
 * browser-safe bundle (`export()` / `emitBundle`, the surface a frontend reaches
 * for types). They live ONLY in the Node deploy path's `content/` files. A
 * regression that routed seed through `export()` would leak row data into any
 * frontend that value-imports the workspace def.
 */
const SENTINEL = "SEED_SENTINEL_VALUE_XYZZY";

const seeded = table({
  name: "widgets",
  schema: { name: f.text() },
  seed: [{ name: SENTINEL }],
});

describe("seed data is isolated from the browser-safe bundle", () => {
  const xano = workspace("iso-app").registerTables([seeded]);

  it("emitBundle output contains no seed row values", () => {
    const json = emitBundle(xano);
    expect(json).not.toContain(SENTINEL);
  });

  it("the exported dbo carries import:{mode:standard} but no inline seed data", () => {
    const bundle = xano.export();
    const dbo = (bundle.payload.dbo as Array<Record<string, unknown>>)[0]!;
    expect(dbo.import).toEqual({ mode: "standard" });
    // No inline row payload leaked onto the schema object.
    expect(JSON.stringify(dbo)).not.toContain(SENTINEL);
  });

  it("the seed values DO live in the Node deploy path's content files", async () => {
    const files = await buildSeedContentFiles(xano.tables());
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain(SENTINEL);
  });
});
