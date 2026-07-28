/**
 * U12 — the raw-first walking skeleton, and the gate Phase A exits through.
 *
 * `examples/sandbox/index.ts` is the oracle because it is the only workspace
 * registering all 12 kinds. The contract is end to end and deliberately blunt:
 * export it, decode the bundle to a tree of source files, write them, import the
 * generated entry, export *that*, and require the two bundles to be
 * `normalize()`-equal.
 *
 * Every statement decodes to `raw()` at this stage, so the tree is exact and
 * unreadable — which is the point. R2 is satisfiable by `raw()` alone, so each
 * later decoder is a readability upgrade measured against a round trip that is
 * already green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../../src/validate/normalize.js";
import { decodeBundle } from "../../src/codegen/index.js";
import type { GeneratedProject } from "../../src/codegen/index.js";
import type { Bundle } from "../../src/workspace/export.js";
import sandbox from "../../examples/sandbox/index.js";

/** Written inside the vite root so the generated tree resolves `@sidestep/core`. */
const OUT_ROOT = fileURLToPath(new URL("../.generated/", import.meta.url));

/** Write a decoded project to disk and return its entry path. */
function writeProject(project: GeneratedProject, name: string): string {
  const root = join(OUT_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  for (const file of project.files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
  }
  return join(root, "index.ts");
}

/** Export a generated tree by importing its entry and calling `export()`. */
async function exportGenerated(entry: string): Promise<Bundle> {
  const mod = (await import(/* @vite-ignore */ entry)) as { default: { export(): Bundle } };
  return mod.default.export();
}

const ENGINE_BUNDLE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/codegen/engine-guids-bundle.json", import.meta.url)),
    "utf8",
  ),
) as Bundle;

describe("walking skeleton — whole-workspace round trip", () => {
  let source: Bundle;
  let project: GeneratedProject;
  let regenerated: Bundle;

  beforeAll(async () => {
    source = sandbox.export();
    project = decodeBundle(source);
    regenerated = await exportGenerated(writeProject(project, "sandbox"));
  });

  afterAll(() => rmSync(OUT_ROOT, { recursive: true, force: true }));

  it("re-exports normalize()-equal to the source bundle", () => {
    expect(normalize(regenerated.payload)).toEqual(normalize(source.payload));
  });

  it("emits every kind present in the source workspace", () => {
    const populated = Object.entries(source.payload)
      .filter(([, section]) => Array.isArray(section) && section.length > 0)
      .map(([key]) => key);
    for (const key of populated) {
      const section = (regenerated.payload as Record<string, unknown>)[key];
      expect(Array.isArray(section) && section.length, `payload.${key}`).toBe(
        (source.payload as Record<string, unknown[]>)[key]!.length,
      );
    }
    // The sandbox is the all-12-kinds workspace; functions and workspace config
    // are the two the curated capture subset omits, so assert them by name.
    expect(populated).toContain("function");
    expect(regenerated.payload.workspace).toEqual(source.payload.workspace);
  });

  it("writes a barrel entry plus a tsconfig", () => {
    const paths = project.files.map((f) => f.path);
    expect(paths).toContain("index.ts");
    expect(paths).toContain("tsconfig.json");
  });

  it("produces byte-identical files when the same bundle is decoded twice", () => {
    expect(decodeBundle(source).files).toEqual(project.files);
  });

  // Worth its runtime: a decoder can emit a def that re-encodes to the right
  // bytes while being ill-typed — a key the encoder ignores gets its default
  // re-emitted, so the round trip passes by luck. Type-checking is what catches
  // that class of bug (it found the agent provider-config casing and a missing
  // required `hasResult` on first run).
  it("type-checks under tsc --noEmit", () => {
    const root = join(OUT_ROOT, "sandbox");
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    writeFileSync(
      join(root, "tsconfig.check.json"),
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          typeRoots: [join(repo, "node_modules/@types")],
          types: ["node"],
          paths: {
            "@sidestep/core": [join(repo, "src/index.ts")],
            "@sidestep/core/codegen": [join(repo, "src/codegen-entry.ts")],
          },
        },
      }),
    );
    const result = spawnSync(
      "npx",
      ["tsc", "--noEmit", "-p", join(root, "tsconfig.check.json")],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 120_000);

  // The metric Phase B drove down: 526 (every statement raw at the U12 skeleton)
  // → 366 after spec inversion → 50 after the first specials tranche → 0. Held at
  // zero rather than asserted loosely, so a statement that starts falling back —
  // because an encoder changed shape, or a new one landed without a decoder — is
  // a red test and a deliberate decision, not a silent readability regression.
  it("decodes every sandbox statement without a raw fallback", () => {
    const rawFallbacks = project.report
      .summarize()
      .byCategory.find((g) => g.category === "raw-fallback");
    expect(rawFallbacks?.entries ?? []).toEqual([]);
  });

  it("preserves every engine-random guid through a full skeleton round trip", async () => {
    const out = await exportGenerated(
      writeProject(decodeBundle(ENGINE_BUNDLE), "engine-guids"),
    );
    const guidsOf = (bundle: Bundle) =>
      Object.entries(bundle.payload)
        .filter(([, section]) => Array.isArray(section))
        .flatMap(([key, section]) =>
          (section as Array<{ guid?: string; name?: string }>).map(
            (o) => `${key}:${o.name}:${o.guid}`,
          ),
        )
        .sort();
    expect(guidsOf(out)).toEqual(guidsOf(ENGINE_BUNDLE));
  });
});
