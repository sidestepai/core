import { describe, it, expect } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileBundle, parseArgs } from "../../src/emit/cli.js";
import { resolveSeedRows } from "../../src/workspace/seed.js";
import { seedFile } from "../../src/kinds/table.js";
import { deriveGuid } from "../../src/refs/guid.js";

/**
 * U4 — the compile→deploy seam. `compileBundle` resolves a seeded entry's rows
 * into `content/` archive entries ONLY when the deploy path asks (`seed:true`);
 * a plain export/validate compile never touches seed sources.
 */
const entry = fileURLToPath(new URL("../fixtures/seed-workspace/index.ts", import.meta.url));

describe("compileBundle seed threading", () => {
  it("builds content/ files for a seeded entry when seed:true", async () => {
    const args = parseArgs(["deploy", entry]);
    const { bundle, content } = await compileBundle(args, { seed: true });

    // The workspace bundle itself is schema-only (no inline seed rows).
    expect(bundle).not.toContain("Widget");

    const guid = deriveGuid("dbo", "products");
    expect(content).toHaveLength(1);
    expect(content[0]!.name).toBe(`content/${guid}-1.json`);
    const env = JSON.parse(content[0]!.content) as { type: string; payload: unknown[] };
    expect(env.type).toBe("content");
    expect(env.payload).toEqual([
      { name: "Widget", price: 9.99, id: 1 },
      { name: "Gadget", price: 19.99, id: 2 },
    ]);
  });

  it("does not resolve seed content by default (export/validate path)", async () => {
    const args = parseArgs(["export", entry]);
    const { content } = await compileBundle(args);
    expect(content).toEqual([]);
  });
});

/**
 * `seedFile()` — the form that cannot reach a frontend bundle (issue #204).
 *
 * The deferred thunk was documented as keeping seed values out of a frontend
 * build. It does not: the `import()` lives in the consumer's module, so Rollup
 * emits the JSON as a served chunk. A path string has nothing for a bundler to
 * follow, and is read with `node:fs` only here, on the deploy path.
 */
describe("seedFile sources", () => {
  const fileEntry = fileURLToPath(
    new URL("../fixtures/seed-file-workspace/index.ts", import.meta.url),
  );

  it("resolves rows from the JSON file, relative to the DECLARING module", async () => {
    // The table is declared in `tables/products.ts` and names `../rows.json`,
    // so a resolution against the entry (or the cwd) would miss the file.
    const args = parseArgs(["deploy", fileEntry]);
    const { bundle, content } = await compileBundle(args, { seed: true });

    expect(bundle).not.toContain("Widget"); // still schema-only
    expect(content).toHaveLength(1);
    const env = JSON.parse(content[0]!.content) as { type: string; payload: unknown[] };
    expect(env.type).toBe("content");
    expect(env.payload).toEqual([
      { name: "Widget", price: 9.99, id: 1 },
      { name: "Gadget", price: 19.99, id: 2 },
    ]);
  });

  it("does not read the file on the export path", async () => {
    const args = parseArgs(["export", fileEntry]);
    const { content } = await compileBundle(args);
    expect(content).toEqual([]);
  });

  it("names the resolved absolute path when the file is missing", async () => {
    await expect(
      resolveSeedRows(seedFile("./nope.json", import.meta.url)),
    ).rejects.toThrow(/nope\.json/);
    await expect(
      resolveSeedRows(seedFile("./nope.json", import.meta.url)),
    ).rejects.toThrow(/cannot read/);
  });

  it("rejects a JSON file that is not an array of rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidestep-seedfile-"));
    try {
      writeFileSync(join(dir, "obj.json"), '{"not":"an array"}');
      writeFileSync(join(dir, "bad.json"), "{ this is not json");
      const base = pathToFileURL(join(dir, "entry.ts")).href;
      await expect(resolveSeedRows(seedFile("./obj.json", base))).rejects.toThrow(
        /must hold an array of seed rows/,
      );
      await expect(resolveSeedRows(seedFile("./bad.json", base))).rejects.toThrow(
        /is not valid JSON/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a plain filesystem path as `base`, not only a URL", async () => {
    const declaring = fileURLToPath(
      new URL("../fixtures/seed-file-workspace/tables/products.ts", import.meta.url),
    );
    const rows = await resolveSeedRows(seedFile("../rows.json", declaring));
    expect(rows).toHaveLength(2);
  });
});
