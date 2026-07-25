import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { compileBundle, parseArgs } from "../../src/emit/cli.js";
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
      { name: "Widget", price: 9.99 },
      { name: "Gadget", price: 19.99 },
    ]);
  });

  it("does not resolve seed content by default (export/validate path)", async () => {
    const args = parseArgs(["export", entry]);
    const { content } = await compileBundle(args);
    expect(content).toEqual([]);
  });
});
