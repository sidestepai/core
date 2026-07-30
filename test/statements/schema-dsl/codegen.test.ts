import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../../../src/statements/schema-dsl/parse.js";
import { schemaToSpec } from "../../../src/statements/schema-dsl/generate.js";
import { applySpecOverrides } from "../../../src/statements/schema-dsl/overrides.js";
import type { StatementSpec } from "../../../src/statements/schema-dsl/interpret.js";
import { GENERATED_SPECS } from "../../../src/statements/generated/catalog.js";

/**
 * Reproducibility gate for the U9 codegen: regenerating from the engine's
 * statement schema YAMLs must produce the same specs the committed catalog ships
 * (compared modulo the `output` flag, which the codegen pins from the persisted
 * fixtures — not present in CI). Point `XANO_SCHEMA_DIR` at a local engine
 * checkout to run it; it skips when that is unset, which is the CI case.
 */
const SCHEMA_DIR = process.env.XANO_SCHEMA_DIR ?? "";

/** Drop fixture-pinned fields (`output`, `envelope`) so the comparison is source-only. */
function structural(spec: StatementSpec): Omit<StatementSpec, "output" | "envelope"> {
  const { output: _output, envelope: _envelope, ...rest } = spec;
  void _output;
  void _envelope;
  return rest;
}

function regenerate(): StatementSpec[] {
  const specs: StatementSpec[] = [];
  for (const file of readdirSync(SCHEMA_DIR).sort()) {
    if (!file.endsWith(".yaml")) continue;
    const result = schemaToSpec(parseYaml(readFileSync(join(SCHEMA_DIR, file), "utf8")));
    if ("spec" in result) {
      applySpecOverrides(result.spec);
      specs.push(result.spec);
    }
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}

describe("U9 codegen reproducibility", () => {
  const available = existsSync(SCHEMA_DIR);
  it.runIf(available)("regenerated specs match the committed catalog (modulo fixture-pinned output)", () => {
    const regenerated = regenerate().map(structural);
    const committed = [...GENERATED_SPECS]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(structural);
    expect(regenerated).toEqual(committed);
  });

  it.skipIf(available)("skipped: XANO_SCHEMA_DIR not set", () => {
    expect(GENERATED_SPECS.length).toBeGreaterThan(0);
  });
});

describe("upstream-schema overrides (applySpecOverrides)", () => {
  const callTool = GENERATED_SPECS.find((s) => s.name === "mvp:mcp_call_tool");

  it("mvp:mcp_call_tool `args` has no bogus default (#86.3)", () => {
    const args = callTool?.rules.find((r) => r.field === "args");
    expect(args).toBeDefined();
    expect(args?.default).toBeUndefined();
  });

  it("mvp:mcp_call_tool `connection_type` keeps its legitimate 'sse' default (no over-scrub)", () => {
    const ct = callTool?.rules.find((r) => r.field === "connection_type");
    expect(ct?.default).toBe("sse");
  });

  it("the override is idempotent (re-applying leaves the scrubbed spec unchanged)", () => {
    const spec = structuredClone(callTool!);
    applySpecOverrides(spec);
    expect(spec.rules.find((r) => r.field === "args")?.default).toBeUndefined();
    expect(spec.rules.find((r) => r.field === "connection_type")?.default).toBe("sse");
  });
});
