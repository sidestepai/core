/**
 * Statement-catalog codegen (U9). Reads the engine's statement schema YAMLs,
 * interprets each declarative `transform` into a `StatementSpec`, pins the
 * engine-only `output` flag from the persisted golden fixtures, and writes the
 * committed catalog data (`src/statements/generated/specs.generated.ts`) plus a
 * pending log (`src/statements/generated/PENDING.md`) of everything deferred.
 *
 * Run (regenerates the committed output):
 *   npm run codegen
 *
 * Sources — pointed at a local engine checkout by the person running this. There
 * is no default: the layout of that checkout is not this repo's to record.
 *   XANO_SCHEMA_DIR       — REQUIRED. Dir of per-statement schema YAMLs (the codegen input)
 *   XANO_FIXTURE_DIR      — dir of persisted transform goldens (pins the `output` flag)
 *   XANO_INPUT_SCHEMA_DIR — dir of per-statement runtime input schemas (pins field `enum`s)
 *
 * Only the first is required. The other two PIN facts the transform schema does
 * not carry, and each already-committed fact is a floor: a run that cannot see
 * the source carries it forward rather than silently unpinning it (see main).
 *
 * Codegen is reproducible: re-running on the same sources produces identical
 * output (specs sorted by name; deterministic serialization).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parseYaml } from "../src/statements/schema-dsl/parse.ts";
import { schemaToSpec } from "../src/statements/schema-dsl/generate.ts";
import { applySpecOverrides } from "../src/statements/schema-dsl/overrides.ts";
import { attachEnums } from "../src/statements/schema-dsl/enums.ts";
import { parseInputSchema } from "../src/statements/schema-dsl/input-schema.ts";
import type { StatementEnums } from "../src/statements/schema-dsl/input-schema.ts";
import type { EnvelopeProfile, StatementSpec } from "../src/statements/schema-dsl/interpret.ts";
import { GENERATED_SPECS as COMMITTED_SPECS } from "../src/statements/generated/specs.generated.ts";

const SCHEMA_DIR = process.env.XANO_SCHEMA_DIR ?? "";
const FIXTURE_DIR = process.env.XANO_FIXTURE_DIR ?? "";
const INPUT_SCHEMA_DIR = process.env.XANO_INPUT_SCHEMA_DIR ?? "";
/** Allow this run's fixtures to REMOVE a committed envelope profile or enum (see main). */
const REPIN = process.argv.includes("--repin");
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

/**
 * Index the runtime input schemas: statement name → its enum-constrained fields.
 * An absent dir yields an empty index, which the committed floor in `main` then
 * fills from the catalog — regeneration without this source must not strip enums.
 */
function buildEnumIndex(dir: string, known: ReadonlySet<string>): Map<string, StatementEnums> {
  const index = new Map<string, StatementEnums>();
  if (!existsSync(dir)) return index;
  // Files only — the source tree nests statement families in subdirectories.
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const parsed = parseInputSchema(readFileSync(join(dir, entry.name), "utf8"), known);
    if (parsed) index.set(parsed.name, parsed.enums);
  }
  return index;
}

/** Read the enums already committed for a statement, as an index entry. */
function committedEnums(spec: StatementSpec): StatementEnums | undefined {
  const entry: StatementEnums = {};
  for (const rule of spec.rules) {
    if (rule.route.kind === "input" && rule.enum) entry[rule.route.name] = rule.enum;
  }
  return Object.keys(entry).length === 0 ? undefined : entry;
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
    if (r.enum !== undefined) rule.enum = r.enum;
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

/**
 * Schema basenames this SDK deliberately files under a DIFFERENT namespace than
 * the engine's own layout implies.
 *
 * Distinct from the corrections in `src/statements/schema-dsl/overrides.ts`:
 * those fix upstream schema DEFECTS, whereas nothing here is wrong upstream.
 * These are SideStep authoring decisions about where a statement belongs on its
 * own surface, and they live in codegen (rather than as a hand-edit of the
 * generated file) so a regeneration reproduces them instead of reverting them.
 *
 * - `api.microservice` → `microservice.request`: a microservice is a
 *   first-class workspace object with its own def factory and deploy path, so
 *   the statement that calls one belongs beside it rather than filed under the
 *   external-HTTP-request namespace it shares almost nothing with.
 */
const NAMESPACE_OVERRIDES: Readonly<Record<string, string>> = {
  "api.microservice": "microservice.request",
  // A lambda runs wherever a stack runs — functions, tasks, middleware,
  // triggers — so `s.api.lambda` said something false about where it is
  // available (issue #221). The stored name is unchanged; only the authoring
  // path moves. Mirrored by the `lambda` key in src/statements/surfaces.ts.
  "api.lambda": "lambda",
};

/** Derive the namespace path + method from a schema filename basename. */
function namespaceOf(base: string): { path: string[]; method: string } {
  const bare = base.replace(/^stack\|/, "");
  const segs = (NAMESPACE_OVERRIDES[bare] ?? bare).split(".");
  const method = segs.pop()!;
  return { path: segs, method };
}

const TS_TYPE: Record<string, string> = { string: "string", value: "Value", comparison: "Condition" };

/**
 * Per-field authored-type overrides, keyed `<stored name>.<field>`.
 *
 * The lambda statement's `code` also takes the body ITSELF — an inline function
 * whose parameter destructures the bindings for the statement surface, so they
 * autocomplete at the call site and a filter-only binding like `$this` is a
 * compile error there (issue #221). The stored bytes are unchanged: the factory
 * resolves the function to the same `const:text` a `c.text(...)` carried.
 */
const FIELD_TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  "mvp:lambda.code": 'Value | LambdaBody<"s.lambda">',
};

/**
 * The authored type for one field. An enum-constrained field renders as its
 * legal values (in the engine's declared order — the editor's dropdown order,
 * which reads as intentional) plus `Value`: the literal spelling puts the legal
 * set in autocomplete at the call site and makes a typo a compile error, while
 * `Value` keeps the dynamic-binding escape hatch open. Both spellings encode to
 * the same bytes (see `encodeFromSpec`).
 */
function fieldType(r: StatementSpec["rules"][number], storedName: string): string {
  const override = FIELD_TYPE_OVERRIDES[`${storedName}.${r.field}`];
  if (override) return override;
  if (!r.enum) return TS_TYPE[r.type]!;
  return [...r.enum.map((v) => JSON.stringify(v)), TS_TYPE[r.type]!].join(" | ");
}

/** TS arg-object type + whether the whole object can default to `{}`. */
function argSignature(spec: StatementSpec): { type: string; allOptional: boolean } {
  const fields = spec.rules.map((r) => {
    const optional = r.optional || r.default !== undefined;
    return `${r.field}${optional ? "?" : ""}: ${fieldType(r, spec.name)}`;
  });
  // Reserved envelope authoring keys (always optional). `disabled` and
  // `description` are on EVERY statement — they annotate the stack item rather
  // than argue the statement, and `encodeStatement` writes both unconditionally,
  // so gating them on the envelope profile only hid them from autocomplete.
  // `output` shaping is per-statement, and stays gated. See encodeFromSpec.
  fields.push("disabled?: boolean", "description?: string");
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
import type { LambdaBody } from "../../values/lambda.js";
import type { Condition } from "../conditional.js";
import { GENERATED_SPECS } from "./specs.generated.js";

const SPECS = new Map(GENERATED_SPECS.map((s) => [s.name, s]));
const fromSpec = (name: string, a: object): Statement => encodeFromSpec(SPECS.get(name)!, a as Authored);

export const generated = ${serializeNamespace(tree, "")};
`;
  writeFileSync(OUT_FACTORIES, file);
}

function main(): void {
  if (!existsSync(SCHEMA_DIR)) {
    console.error(
      SCHEMA_DIR === ""
        ? "Set XANO_SCHEMA_DIR to the statement-schema directory of a local engine checkout."
        : `Schema dir not found: ${SCHEMA_DIR}`,
    );
    process.exit(1);
  }
  const fixtureProfiles = buildFixtureProfileIndex(FIXTURE_DIR);
  // Envelope profiles are pinned from goldens, and a partial or absent fixture
  // dir would silently UNPIN them — rewriting `output`/`envelope` for statements
  // whose bytes never changed, purely because this run saw fewer fixtures than
  // the one that committed them. So the profiles already committed are the floor:
  // a fixture may confirm or add one, and only `--repin` (a run the author knows
  // is fixture-complete) is allowed to remove one. That keeps a signature-only
  // change like adding an envelope field regenerable without an engine checkout.
  //
  // Carrying a profile forward is NOT proof, so `proven` is captured from this
  // run's fixtures alone — PENDING.md keeps reporting which statements still
  // have no vendored golden, which is the whole point of that list.
  const proven = new Set(fixtureProfiles.keys());
  if (!REPIN) {
    for (const spec of COMMITTED_SPECS) {
      if (fixtureProfiles.has(spec.name)) continue;
      fixtureProfiles.set(spec.name, {
        hasOutput: spec.output === true,
        envelope: { ...(spec.envelope ?? {}) },
      });
    }
  }

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
    applySpecOverrides(spec);
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
    }
    // Keyed on this run's fixtures, not on whether a profile was found — a
    // carried-forward profile leaves the statement exactly as unverified as it was.
    if (!proven.has(spec.name)) {
      unproven.push(spec.name); // no fixture → byte-fidelity unverified
    }
    specs.push(spec);
  }

  // Enums attach in a SECOND pass: resolving a source to its statement needs the
  // full set of catalog names, which only exists once every schema has been read.
  // Still after `applySpecOverrides` — that pass synthesizes and renames input
  // rules, and the enum joins on the stored input name (see enums.ts).
  //
  // The same floor rule as the envelope profiles, for the same reason: an absent
  // or partial input-schema dir would otherwise silently strip a statement's
  // committed constraints — un-narrowing its factory signature and disarming its
  // guard — purely because this run saw fewer sources than the one that
  // committed them.
  const enumIndex = buildEnumIndex(INPUT_SCHEMA_DIR, new Set(specs.map((s) => s.name)));
  if (!REPIN) {
    for (const spec of COMMITTED_SPECS) {
      if (enumIndex.has(spec.name)) continue;
      const carried = committedEnums(spec);
      if (carried) enumIndex.set(spec.name, carried);
    }
  }
  for (const spec of specs) attachEnums(spec, enumIndex);

  specs.sort((a, b) => a.name.localeCompare(b.name));

  const header = `/**
 * AUTO-GENERATED by scripts/codegen.ts — DO NOT EDIT BY HAND.
 *
 * The declarative statement catalog (U9): one StatementSpec per cleanly
 * interpretable statement schema, generated from the Xano engine's statement
 * schema definitions. The engine-only \`output\` flag is pinned from the
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
  // PENDING.md is a report on FIXTURE coverage, so a run with no fixture dir has
  // nothing to say about it — rewriting it from an empty index would report every
  // statement as newly unproven, which is a statement about this run's inputs and
  // not about the catalog. Left as committed instead.
  const haveFixtures = existsSync(FIXTURE_DIR);
  if (haveFixtures) writeFileSync(OUT_PENDING, pending);

  console.log(
    haveFixtures
      ? `codegen: ${specs.length} specs (${provenCount} fixture-proven, ${unproven.length} unproven), ${skipped.length} deferred.`
      : `codegen: ${specs.length} specs, ${skipped.length} deferred. No XANO_FIXTURE_DIR — envelope profiles carried ` +
        `forward from the committed specs and PENDING.md left untouched (pass --repin with a complete fixture dir to re-pin).`,
  );
}

main();
