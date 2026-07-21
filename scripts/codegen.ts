/**
 * Statement-catalog codegen (U9). Reads the cloud-client statement schema YAMLs,
 * interprets each declarative `transform` into a `StatementSpec`, pins the
 * engine-only `output` flag from the persisted golden fixtures, and writes the
 * committed catalog data (`src/statements/generated/specs.generated.ts`) plus a
 * pending log (`src/statements/generated/PENDING.md`) of everything deferred.
 *
 * Run (regenerates the committed output):
 *   npm run codegen
 *
 * Sources (override via env):
 *   XANO_SCHEMA_DIR  — statement/*.yaml         (the codegen input)
 *   XANO_FIXTURE_DIR — transform-temp/*.json    (persisted fixtures; pins `output`)
 *
 * Codegen is reproducible: re-running on the same sources produces identical
 * output (specs sorted by name; deterministic serialization).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseYaml } from "../src/statements/schema-dsl/parse.ts";
import { schemaToSpec } from "../src/statements/schema-dsl/generate.ts";
import type { EnvelopeProfile, StatementSpec } from "../src/statements/schema-dsl/interpret.ts";

const CLOUD_CLIENT = join(homedir(), "git/cloud-client/extensions/MVP/includes/xano");
const SCHEMA_DIR = process.env.XANO_SCHEMA_DIR ?? join(CLOUD_CLIENT, "script/kind/schema/statement");
const FIXTURE_DIR = process.env.XANO_FIXTURE_DIR ?? join(CLOUD_CLIENT, "test/script/data/transform-temp");
const OUT_SPECS = join(import.meta.dirname, "../src/statements/generated/specs.generated.ts");
const OUT_FACTORIES = join(import.meta.dirname, "../src/statements/generated/factories.generated.ts");
const OUT_PENDING = join(import.meta.dirname, "../src/statements/generated/PENDING.md");

/** The engine-class metadata a statement's persisted fixture reveals (KTD-4). */
interface FixtureProfile {
  hasOutput: boolean;
  envelope: EnvelopeProfile;
}

/** Derive a statement's envelope profile from one persisted fixture JSON. */
function profileFromFixture(json: Record<string, unknown>): FixtureProfile {
  const env: EnvelopeProfile = {};
  if ("as" in json) env.emitAs = true;
  if ("description" in json) env.description = true;
  if ("settings_registry" in json) env.settingsRegistry = true;
  if ("addon" in json) env.addon = true;
  const out = json.output;
  if (out !== null && typeof out === "object" && "customize" in out) env.richOutput = true;
  const input = json.input;
  if (Array.isArray(input) && input[0] && typeof input[0] === "object" && "ignore" in input[0]) {
    env.inputFull = true;
  }
  return { hasOutput: "output" in json, envelope: env };
}

/**
 * Index the persisted fixtures: statement name → its derived profile, merged
 * across every fixture for that name. A statement often has several fixtures
 * (e.g. `array_push` + an `-empty` variant); the empty/degenerate ones drop
 * keys, so the canonical profile is the UNION (richest) — `hasOutput` and each
 * envelope flag are OR-ed.
 */
function buildFixtureProfileIndex(dir: string): Map<string, FixtureProfile> {
  const index = new Map<string, FixtureProfile>();
  if (!existsSync(dir)) return index;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    const name = json.name;
    if (typeof name !== "string") continue;
    const p = profileFromFixture(json);
    const prev = index.get(name);
    if (!prev) {
      index.set(name, p);
    } else {
      prev.hasOutput ||= p.hasOutput;
      for (const k of Object.keys(p.envelope) as (keyof EnvelopeProfile)[]) {
        if (p.envelope[k]) prev.envelope[k] = true;
      }
    }
  }
  return index;
}

/** True when an envelope profile carries no flags (a lean statement). */
function isLeanEnvelope(env: EnvelopeProfile): boolean {
  return Object.keys(env).length === 0;
}

/** Stable-ordered envelope literal (only the flags that are set). */
function serializeEnvelope(env: EnvelopeProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env.inputFull) out.inputFull = true;
  if (env.emitAs) out.emitAs = true;
  if (env.description) out.description = true;
  if (env.settingsRegistry) out.settingsRegistry = true;
  if (env.addon) out.addon = true;
  if (env.richOutput) out.richOutput = true;
  return out;
}

/** Deterministic TS object literal for a spec (stable key order). */
function serializeSpec(spec: StatementSpec): string {
  const ordered: Record<string, unknown> = { name: spec.name };
  if (spec.argNameIsVar) ordered.argNameIsVar = true;
  if (spec.output) ordered.output = true;
  ordered.rules = spec.rules.map((r) => {
    const route: Record<string, unknown> = { kind: r.route.kind };
    if ("path" in r.route) route.path = r.route.path;
    if ("name" in r.route) route.name = r.route.name;
    const rule: Record<string, unknown> = { field: r.field, type: r.type, optional: r.optional };
    if (r.default !== undefined) rule.default = r.default;
    rule.route = route;
    return rule;
  });
  if (spec.envelope && !isLeanEnvelope(spec.envelope)) {
    ordered.envelope = serializeEnvelope(spec.envelope);
  }
  return JSON.stringify(ordered);
}

// ── Typed namespaced factory tree ────────────────────────────────────────────
// Turns every generated spec into a discoverable, autocomplete-friendly factory
// reachable as `s.<namespace>.<method>({…})`. The namespace path comes from the
// schema filename (`math.add` → `s.math.add`, `db.get` → `s.db.get`).

interface FactoryEntry {
  spec: StatementSpec;
  path: string[]; // namespace segments, e.g. ["math"]
  method: string; // leaf, e.g. "add"
}

/** Derive the namespace path + method from a schema filename basename. */
function namespaceOf(base: string): { path: string[]; method: string } {
  const segs = base.replace(/^stack\|/, "").split(".");
  const method = segs.pop()!;
  return { path: segs, method };
}

const TS_TYPE: Record<string, string> = { string: "string", value: "Value", comparison: "Comparison" };

/** TS arg-object type + whether the whole object can default to `{}`. */
function argSignature(spec: StatementSpec): { type: string; allOptional: boolean } {
  const fields = spec.rules.map((r) => {
    const optional = r.optional || r.default !== undefined;
    return `${r.field}${optional ? "?" : ""}: ${TS_TYPE[r.type]}`;
  });
  // Reserved envelope authoring keys (always optional): a per-statement
  // `description` when the envelope emits one, and `output` shaping when the
  // statement carries an output envelope. See interpret.ts encodeFromSpec.
  if (spec.envelope?.description) fields.push("description?: string");
  if (spec.output) fields.push("output?: OutputAuthored");
  const allOptional = spec.rules.every((r) => r.optional || r.default !== undefined);
  return { type: fields.length ? `{ ${fields.join("; ")} }` : "Record<string, never>", allOptional };
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function key(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

interface TreeNode {
  children: Map<string, TreeNode>;
  leaf?: FactoryEntry;
}

function buildTree(entries: FactoryEntry[]): TreeNode {
  const root: TreeNode = { children: new Map() };
  for (const e of entries) {
    let node = root;
    for (const seg of e.path) {
      if (!node.children.has(seg)) node.children.set(seg, { children: new Map() });
      node = node.children.get(seg)!;
    }
    if (!node.children.has(e.method)) node.children.set(e.method, { children: new Map() });
    node.children.get(e.method)!.leaf = e;
  }
  return root;
}

function serializeLeaf(e: FactoryEntry): string {
  const { type, allOptional } = argSignature(e.spec);
  const param = allOptional ? `a: ${type} = {}` : `a: ${type}`;
  const fields = e.spec.rules.map((r) => r.field).join(", ") || "(none)";
  return `/** \`${e.spec.name}\` — fields: ${fields} */\n(${param}): Statement => fromSpec(${JSON.stringify(
    e.spec.name,
  )}, a)`;
}

/** A namespace object literal `{ seg: <value>, … }`. */
function serializeNamespace(node: TreeNode, indent: string): string {
  const inner = indent + "  ";
  const parts: string[] = [];
  for (const [seg, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`${inner}${key(seg)}: ${serializeValue(child, inner)}`);
  }
  return `{\n${parts.join(",\n")},\n${indent}}`;
}

/** Serialize a node: a bare factory, a namespace, or (collision) a factory carrying sub-methods. */
function serializeValue(node: TreeNode, indent: string): string {
  const hasChildren = node.children.size > 0;
  if (node.leaf && !hasChildren) return serializeLeaf(node.leaf);
  if (!node.leaf) return serializeNamespace(node, indent);
  // Both a factory and a namespace (e.g. `var` + `var.update`): a callable with sub-methods.
  return `Object.assign(\n${indent}  ${serializeLeaf(node.leaf)},\n${indent}  ${serializeNamespace(
    node,
    indent + "  ",
  )},\n${indent})`;
}

function writeFactories(entries: FactoryEntry[]): void {
  const tree = buildTree(entries);
  const file = `/**
 * AUTO-GENERATED by scripts/codegen.ts — DO NOT EDIT BY HAND.
 *
 * Typed, namespaced factories for the declarative statement catalog (U9): every
 * generated statement is reachable + autocomplete-discoverable as
 * \`generated.<namespace>.<method>({…})\` (e.g. \`generated.math.add\`,
 * \`generated.db.get\`). The unified public surface is \`s\` in ../s.ts, which
 * merges these with the hand-authored control-flow specials. Regenerate with
 * \`npm run codegen\`.
 */
import type { Statement } from "../statement.js";
import type { Authored, OutputAuthored } from "../schema-dsl/interpret.js";
import { encodeFromSpec } from "../schema-dsl/interpret.js";
import type { Value } from "../../values/value.js";
import type { Comparison } from "../conditional.js";
import { GENERATED_SPECS } from "./specs.generated.js";

const SPECS = new Map(GENERATED_SPECS.map((s) => [s.name, s]));
const fromSpec = (name: string, a: object): Statement => encodeFromSpec(SPECS.get(name)!, a as Authored);

export const generated = ${serializeNamespace(tree, "")};
`;
  writeFileSync(OUT_FACTORIES, file);
}

function main(): void {
  if (!existsSync(SCHEMA_DIR)) {
    console.error(`Schema dir not found: ${SCHEMA_DIR}\nSet XANO_SCHEMA_DIR to the cloud-client statement schema dir.`);
    process.exit(1);
  }
  const fixtureProfiles = buildFixtureProfileIndex(FIXTURE_DIR);

  const specs: StatementSpec[] = [];
  const entries: FactoryEntry[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const unproven: string[] = [];

  for (const file of readdirSync(SCHEMA_DIR).sort()) {
    if (!file.endsWith(".yaml")) continue;
    const doc = parseYaml(readFileSync(join(SCHEMA_DIR, file), "utf8"));
    const result = schemaToSpec(doc);
    if ("skip" in result) {
      skipped.push({ file: basename(file), reason: result.skip });
      continue;
    }
    const spec = result.spec;
    const { path, method } = namespaceOf(basename(file, ".yaml"));
    entries.push({ spec, path, method });
    const profile = fixtureProfiles.get(spec.name);
    if (profile) {
      // Pin engine-class metadata (output + envelope shape) from the fixture.
      spec.output = profile.hasOutput;
      // `emitAs` is redundant when a rule already routes `as`.
      if (profile.envelope.emitAs && spec.rules.some((r) => r.route.kind === "as")) {
        delete profile.envelope.emitAs;
      }
      if (!isLeanEnvelope(profile.envelope)) spec.envelope = profile.envelope;
    } else {
      unproven.push(spec.name); // no fixture → lean envelope assumed, byte-fidelity unverified
    }
    specs.push(spec);
  }

  specs.sort((a, b) => a.name.localeCompare(b.name));

  const header = `/**
 * AUTO-GENERATED by scripts/codegen.ts — DO NOT EDIT BY HAND.
 *
 * The declarative statement catalog (U9): one StatementSpec per cleanly
 * interpretable statement schema, generated from the cloud-client
 * statement/*.yaml files. The engine-only \`output\` flag is pinned from the
 * persisted golden fixtures (KTD-4). Regenerate with \`npm run codegen\`.
 *
 * Coverage: ${specs.length} declarative statements generated.
 * Deferred (see PENDING.md): ${skipped.length}.
 */
import type { StatementSpec } from "../schema-dsl/interpret.js";
`;
  const body = `\nexport const GENERATED_SPECS: StatementSpec[] = [\n${specs
    .map((s) => `  ${serializeSpec(s)},`)
    .join("\n")}\n];\n`;
  writeFileSync(OUT_SPECS, header + body);

  entries.sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  writeFactories(entries);

  const provenCount = specs.length - unproven.length;
  const pending = `# Statement catalog — generation report

Generated by \`scripts/codegen.ts\`. Do not edit by hand.

- **Generated declarative specs:** ${specs.length}
  - fixture-proven (\`output\` pinned from a persisted fixture): ${provenCount}
  - registered but unproven (no persisted fixture yet — \`output\` assumed absent): ${unproven.length}
- **Deferred** (skip-with-reason, feeds U10 / coverage): ${skipped.length}

## Registered but unproven (need a vendored fixture to verify byte-fidelity)

${unproven.sort().map((n) => `- \`${n}\``).join("\n") || "_(none)_"}

## Deferred statement schemas

${skipped.map((s) => `- \`${s.file}\` — ${s.reason}`).join("\n")}
`;
  writeFileSync(OUT_PENDING, pending);

  console.log(
    `codegen: ${specs.length} specs (${provenCount} fixture-proven, ${unproven.length} unproven), ${skipped.length} deferred.`,
  );
}

main();
