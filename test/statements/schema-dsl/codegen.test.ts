import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "../../../src/statements/schema-dsl/parse.js";
import { schemaToSpec } from "../../../src/statements/schema-dsl/generate.js";
import { applySpecOverrides } from "../../../src/statements/schema-dsl/overrides.js";
import { attachEnums } from "../../../src/statements/schema-dsl/enums.js";
import { parseInputSchema } from "../../../src/statements/schema-dsl/input-schema.js";
import type { StatementEnums } from "../../../src/statements/schema-dsl/input-schema.js";
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
const INPUT_SCHEMA_DIR = process.env.XANO_INPUT_SCHEMA_DIR ?? "";

/**
 * The enum index this run can prove. When `XANO_INPUT_SCHEMA_DIR` is unset the
 * index is empty and the committed enums are the floor — mirroring the codegen's
 * own rule — so the comparison stays honest either way.
 */
function enumIndex(): Map<string, StatementEnums> {
  const index = new Map<string, StatementEnums>();
  if (!existsSync(INPUT_SCHEMA_DIR)) return index;
  for (const entry of readdirSync(INPUT_SCHEMA_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parsed = parseInputSchema(readFileSync(join(INPUT_SCHEMA_DIR, entry.name), "utf8"));
    if (parsed) index.set(parsed.name, parsed.enums);
  }
  return index;
}

/** Drop fixture-pinned fields (`output`, `envelope`) so the comparison is source-only. */
function structural(spec: StatementSpec): Omit<StatementSpec, "output" | "envelope"> {
  const { output: _output, envelope: _envelope, ...rest } = spec;
  void _output;
  void _envelope;
  return rest;
}

function regenerate(): StatementSpec[] {
  const index = enumIndex();
  // The committed floor, exactly as `scripts/codegen.ts` applies it: a statement
  // this run cannot see an input schema for keeps the enums already committed.
  for (const spec of GENERATED_SPECS) {
    if (index.has(spec.name)) continue;
    const carried: StatementEnums = {};
    for (const rule of spec.rules) {
      if (rule.route.kind === "input" && rule.enum) carried[rule.route.name] = rule.enum;
    }
    if (Object.keys(carried).length > 0) index.set(spec.name, carried);
  }

  const specs: StatementSpec[] = [];
  for (const file of readdirSync(SCHEMA_DIR).sort()) {
    if (!file.endsWith(".yaml")) continue;
    const result = schemaToSpec(parseYaml(readFileSync(join(SCHEMA_DIR, file), "utf8")));
    if ("spec" in result) {
      applySpecOverrides(result.spec);
      // After the overrides — the ordering the codegen depends on (see enums.ts).
      attachEnums(result.spec, index);
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
