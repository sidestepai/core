import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, renderLlmsTxt, OVERRIDDEN_SURFACES } from "../../src/manifest/manifest.js";
import { s } from "../../src/statements/s.js";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import { registeredKinds } from "../../src/kinds/kind.js";
import { TAGS } from "../../src/types/xdo.js";
import { TOTAL_STATEMENTS } from "../../src/statements/surfaces.js";
import { FILTER_NAMES } from "../../src/values/generated/filters.generated.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

/** Collect every callable leaf path under `s` (dotted), matching the manifest's sPath. */
function walkLeaves(node: unknown, path: string[], out: Set<string>): void {
  for (const k of Object.keys(node as Record<string, unknown>)) {
    const v = (node as Record<string, unknown>)[k];
    const p = [...path, k];
    if (typeof v === "function") {
      out.add(p.join("."));
      // A function node can also be a namespace (e.g. cloud.job has .await/.status).
      for (const ck of Object.keys(v)) {
        const cv = (v as unknown as Record<string, unknown>)[ck];
        if (typeof cv === "function" || (cv && typeof cv === "object")) walkLeaves({ [ck]: cv }, p, out);
      }
    } else if (v && typeof v === "object") {
      walkLeaves(v, p, out);
    }
  }
}

describe("manifest", () => {
  const m = buildManifest({ version: pkg.version });

  it("covers every statement surface with no duplicates", () => {
    expect(m.statements).toHaveLength(TOTAL_STATEMENTS);
    const surfaces = m.statements.map((x) => x.surface);
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it("reports honest coverage", () => {
    expect(m.coverage.statements).toEqual({ implemented: TOTAL_STATEMENTS, total: TOTAL_STATEMENTS });
    expect(m.coverage.objectKinds).toEqual({ implemented: 12, total: 24 });
  });

  it("every statement sPath resolves to a real callable leaf under s", () => {
    const leaves = new Set<string>();
    walkLeaves(s, [], leaves);
    for (const stmt of m.statements) {
      expect(leaves.has(stmt.sPath), `${stmt.surface} → s.${stmt.sPath}`).toBe(true);
    }
    // And the manifest accounts for every reachable leaf.
    expect(new Set(m.statements.map((x) => x.sPath)).size).toBe(leaves.size);
  });

  it("declarative entries carry a field schema; specials do not", () => {
    const specNames = new Set(GENERATED_SPECS.map((x) => x.name));
    for (const stmt of m.statements) {
      if (stmt.declarative) {
        expect(specNames.has(stmt.storedName)).toBe(true);
        expect(stmt.fields).toBeDefined();
        expect(typeof stmt.output).toBe("boolean");
      } else {
        expect(stmt.fields).toBeUndefined();
      }
    }
    // Unique declarative stored names == the generated spec catalog, minus the
    // surfaces whose public `s.` factory is a hand-authored typed override (their
    // generated field signature is deliberately suppressed — see OVERRIDDEN_SURFACES).
    const declNames = new Set(m.statements.filter((x) => x.declarative).map((x) => x.storedName));
    const expectedDecl = new Set([...specNames].filter((n) => !OVERRIDDEN_SURFACES.has(n)));
    expect(declNames).toEqual(expectedDecl);
  });

  it("object-kind descriptors match the live kind registry", () => {
    const registered = new Map(registeredKinds().map((k) => [k.name, k.payloadKey]));
    for (const k of m.objectKinds) {
      expect(k.registered).toBe(true);
      expect(registered.get(k.kind)).toBe(k.payloadKey);
    }
    expect(m.objectKinds).toHaveLength(registered.size);
  });

  it("exposes the full tag catalog", () => {
    expect(m.values.tags).toEqual(TAGS);
  });

  it("catalogs every value-pipeline filter with honest typed coverage", () => {
    expect(m.filters.map((f) => f.name)).toEqual([...FILTER_NAMES]);
    expect(m.coverage.filters.total).toBe(FILTER_NAMES.length);
    expect(m.coverage.filters.typed).toBe(m.filters.filter((f) => f.typed).length);
    expect(m.coverage.filters.typed).toBeGreaterThan(0);
    // Typed entries carry args; the fl accessor is always present.
    for (const f of m.filters) {
      expect(f.fl).toBe(`fl.${f.name}`);
      if (f.typed) expect(f.args && f.args.length).toBeGreaterThan(0);
      else expect(f.args).toBeUndefined();
    }
  });

  it("committed manifest.json is up to date (run `npm run manifest`)", () => {
    const committed = readFileSync(join(ROOT, "manifest.json"), "utf8");
    expect(committed).toBe(JSON.stringify(m, null, 2) + "\n");
  });

  it("committed llms.txt is up to date (run `npm run manifest`)", () => {
    const committed = readFileSync(join(ROOT, "llms.txt"), "utf8");
    expect(committed).toBe(renderLlmsTxt(m));
  });
});
