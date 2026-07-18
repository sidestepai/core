import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseYaml } from "../../../src/statements/schema-dsl/parse.js";
import { schemaToSpec } from "../../../src/statements/schema-dsl/generate.js";
import type { StatementSpec } from "../../../src/statements/schema-dsl/interpret.js";
import { GENERATED_SPECS } from "../../../src/statements/generated/catalog.js";

/**
 * Reproducibility gate for the U9 codegen: regenerating from the cloud-client
 * schema YAMLs must produce the same specs the committed catalog ships
 * (compared modulo the `output` flag, which the codegen pins from the persisted
 * fixtures — not present in CI). Skips when the source repo isn't available.
 */
const SCHEMA_DIR =
  process.env.XANO_SCHEMA_DIR ??
  join(homedir(), "git/cloud-client/extensions/MVP/includes/xano/script/kind/schema/statement");

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
    if ("spec" in result) specs.push(result.spec);
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

  it.skipIf(available)("skipped: cloud-client schema source not present", () => {
    expect(GENERATED_SPECS.length).toBeGreaterThan(0);
  });
});
