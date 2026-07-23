/**
 * Empirical field-method probe (issue #106 follow-up) — the authoritative source
 * for which `f.<type>` / `input.<type>` methods the engine actually honors.
 *
 * Field methods (`methods:[]`) are bind-time validators/transforms whose valid set
 * depends on the field TYPE. The SDK distills them from the column-create schema;
 * the `mvp/xs` API reports a per-type list from a different surface, and the two
 * disagree (e.g. `email`). Neither static source nor column import is
 * authoritative: the engine stores ANY method string on a column at import without
 * validating it (verified — a bogus method round-trips). Only RUNTIME input
 * validation rejects an unknown method, with an `Invalid method for filter - <name>`
 * error. So this deploys one function per (type, method) with a typed input
 * carrying that method, runs each, and classifies by that signature — any other
 * outcome means the method resolved.
 *
 * Run: tsx scripts/probe-field-methods.ts   (reads XANO_VALIDATE_* from .env)
 * Output: vendor/field-methods-resolvable.json + a debug detail file.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { workspace, defineFunction, ref, input, serializeBundle } from "../src/index.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

const ROOT = join(import.meta.dirname, "..");

// The methods the SDK currently exposes per type — the primary probe set (catches
// over-exposure: SDK advertises a method the engine rejects at runtime).
const sdk = JSON.parse(readFileSync(join(ROOT, "vendor/field-methods.json"), "utf8")).types as Record<
  string,
  Record<string, string>
>;
// Optional: an engine schema dump (the `mvp/xs` endpoint response) can be supplied
// via XANO_XS_DUMP to ALSO probe methods the SDK lacks (missing-coverage). When
// absent, the probe covers only the SDK's own method set — enough to catch every
// over-exposure. Never hard-coded to a machine path.
const dumpMethods: Record<string, Set<string>> = {};
const dumpPath = process.env.XANO_XS_DUMP;
if (dumpPath && existsSync(dumpPath)) {
  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as { schema: Array<{ name: string; methods?: Array<{ name: string }> }> };
  for (const t of dump.schema) dumpMethods[t.name] = new Set((t.methods ?? []).map((m) => m.name));
}

// Scalar input types we can build with `input.<type>`. tableRef is a synthetic
// ref type (its methods are int's; skipped — no plain input form).
const INPUT_TYPES = ["text", "email", "password", "int", "decimal", "vector"];

// A method needs a value unless it's a boolean toggle. Give int-ish methods `:5`,
// text-ish methods `:x`; the exact value is irrelevant — we only care whether the
// engine keeps the method, not whether the value passes.
const INT_METHODS = new Set(["min", "max", "minAlpha", "minDigit", "minLowerAlpha", "minSymbol", "minUpperAlpha"]);
const TEXT_METHODS = new Set(["startsWith", "pattern", "ok", "salt"]);
const methodStr = (name: string): string =>
  INT_METHODS.has(name) ? `${name}:5` : TEXT_METHODS.has(name) ? `${name}:x` : name;

// Build the (type, method) probe matrix + one function per pair.
const matrix: Array<{ type: string; method: string; fn: string }> = [];
const fns: unknown[] = [];
let i = 0;
for (const type of INPUT_TYPES) {
  const methods = new Set<string>([...Object.keys(sdk[type] ?? {}), ...(dumpMethods[type] ?? new Set())]);
  for (const method of methods) {
    const fn = `fmp_${i++}`;
    matrix.push({ type, method, fn });
    const opts = { methods: [methodStr(method)] };
    const v = type === "vector" ? (input as any).vector(3, opts) : (input as any)[type](opts);
    fns.push(defineFunction({ name: fn, input: { v }, response: ref("v") } as never));
  }
}

const bundle = serializeBundle((workspace("fm_probe").registerFunctions(fns as never) as any).export());
const INVALID = "Invalid method for filter";

async function main() {
  const config = resolveValidateConfig();
  const client = new MetaClient(config);
  console.error(`Importing ${matrix.length} field-method probe functions…`);
  const imp = await client.importBundle(bundle, { reset: true });
  if (imp.workspaceId === undefined) throw new Error(`No workspaceId. Raw: ${imp.raw.slice(0, 400)}`);
  console.error(`Imported to workspace ${imp.workspaceId}. Running…`);

  const results: Array<{ type: string; method: string; resolvable: boolean; sample: string }> = [];
  for (let j = 0; j < matrix.length; j++) {
    const { type, method, fn } = matrix[j];
    const res = await client.runFunction(imp.workspaceId, fn, { v: type === "int" || type === "decimal" ? 5 : type === "vector" ? [1, 2, 3] : "hello" });
    const body = typeof res.body === "string" ? res.body : (JSON.stringify(res.body) ?? "");
    // Phantom iff the engine rejects the method by name; any other outcome means
    // it resolved (validation may still fail on the value — irrelevant here).
    const isPhantom = body.includes(`${INVALID} - ${method}`);
    results.push({ type, method, resolvable: !isPhantom, sample: body.slice(0, 140) });
    if ((j + 1) % 10 === 0) console.error(`  …${j + 1}/${matrix.length}`);
  }

  // Per-type resolvable sets + the phantoms currently exposed by the SDK.
  const byType: Record<string, string[]> = {};
  for (const r of results) if (r.resolvable) (byType[r.type] ??= []).push(r.method);
  for (const t of Object.keys(byType)) byType[t].sort();
  const sdkPhantoms = results
    .filter((r) => !r.resolvable && (sdk[r.type]?.[r.method] !== undefined))
    .map((r) => `${r.type}.${r.method}`);

  writeFileSync(
    join(ROOT, "vendor/field-methods-resolvable.json"),
    JSON.stringify(
      { note: "Empirically runtime-resolvable field methods per type (issue #106). Regenerate with `tsx scripts/probe-field-methods.ts`.", resolvable: byType }, null, 2,
    ) + "\n",
  );
  writeFileSync(join(ROOT, "scripts/probe-field-methods-results.json"), JSON.stringify({ total: results.length, results }, null, 2) + "\n");
  console.error(`\nDone. resolvable=${results.filter((r) => r.resolvable).length} phantom=${results.filter((r) => !r.resolvable).length}`);
  console.error(`SDK-exposed phantoms (${sdkPhantoms.length}): ${sdkPhantoms.join(", ")}`);
  for (const t of INPUT_TYPES) console.error(`  ${t}: ${(byType[t] ?? []).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
