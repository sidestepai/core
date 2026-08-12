/**
 * Filter ARITY probe (issue #246) — how many arguments does the engine actually
 * require, versus how many the SDK's catalog marks as required?
 *
 * #246 turned out not to be about `csv_encode`'s output at all: `fl.csv_encode()`
 * — the form the typed surface invites, since the catalog marks all three of its
 * args `optional` — fails with a FATAL before the filter body ever runs:
 *
 *   Too few arguments to function …, 1 passed and exactly 4 expected
 *
 * That message is an exact oracle. Calling every filter with ZERO arguments makes
 * the engine report its true arity in the error text ("exactly M expected", where
 * the operand is the first of the M). Comparing that against the catalog's
 * declared required-count finds every filter whose `optional` markings are a lie
 * in the same way — the generalized form of the #221 finding.
 *
 * Run (maintainer step; needs a live sandbox):
 *   tsx scripts/probe-filter-arity.ts
 * Writes `scripts/probe-filter-arity-results.json`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, defineFunction, s, c, ref, withFilters, filter, serializeBundle } from "../src/index.js";
import { FILTER_SPECS } from "../src/values/generated/filters.generated.js";
import { resolveValidateConfig } from "../src/validate/config.js";
import { MetaClient } from "../src/validate/meta-client.js";

const ROOT = join(import.meta.dirname, "..");

interface Spec {
  args?: Array<{ name: string; type: string; optional?: boolean }>;
}

const specs = FILTER_SPECS as Readonly<Record<string, Spec>>;
const names = Object.keys(specs).sort();

/** Zero-arg call: the engine's complaint carries its true arity. */
const fns = names.map((name, i) =>
  defineFunction({
    name: `arity_${i}`,
    stack: [s.set_var("out", withFilters(c.array([1, 2]), filter(name)))],
    response: ref("out"),
  }),
);

const TOO_FEW = /Too few arguments to function .*?, (\d+) passed and (?:exactly|at least) (\d+) expected/;

async function main() {
  const ws = workspace("arity_probe").registerFunctions(fns);
  const client = new MetaClient(resolveValidateConfig());
  console.error(`Importing ${fns.length} probes…`);
  const imp = await client.importBundle(serializeBundle((ws as unknown as { export(): unknown }).export()), { reset: true });
  if (imp.workspaceId === undefined) throw new Error(`no workspaceId: ${imp.raw.slice(0, 400)}`);
  console.error(`workspace ${imp.workspaceId}. Running…`);

  const rows: Array<{
    name: string;
    declaredArgs: number;
    declaredRequired: number;
    engineRequired: number | null;
    mismatch: boolean;
    sample: string;
  }> = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const args = specs[name].args ?? [];
    const declaredRequired = args.filter((a) => !a.optional).length;
    const res = await client.runFunction(imp.workspaceId, `arity_${i}`, {});
    const r = (res.body as { result?: { status?: string; exception?: { message?: string } } })?.result;
    const msg = r?.exception?.message ?? "";
    const m = TOO_FEW.exec(msg);
    // Keep only the arity numbers. The raw text names engine-internal symbols,
    // which must not land in a committed artifact.
    const redacted = m ? `too few arguments: ${m[1]} passed, ${m[2]} expected` : msg ? "non-arity error" : "";
    // "exactly M expected" counts the operand, so args-after-operand = M - 1.
    const engineRequired = m ? Number(m[2]) - 1 : null;
    rows.push({
      name,
      declaredArgs: args.length,
      declaredRequired,
      engineRequired,
      // Only a filter the engine demands MORE from than the catalog says is a
      // trap: the author writes the declared-legal call and gets a fatal.
      mismatch: engineRequired !== null && engineRequired > declaredRequired,
      sample: redacted,
    });
    if ((i + 1) % 25 === 0) console.error(`  …${i + 1}/${names.length}`);
  }

  const traps = rows.filter((r) => r.mismatch);
  writeFileSync(
    join(ROOT, "scripts/probe-filter-arity-results.json"),
    JSON.stringify({ note: "Issue #246 — engine-required arity vs. catalog-declared. Regenerate with scripts/probe-filter-arity.ts.", traps, all: rows }, null, 2),
  );

  console.error(`\n${traps.length} filter(s) demand MORE args than the catalog marks required:\n`);
  for (const t of traps) {
    const optionalNames = (specs[t.name].args ?? []).filter((a) => a.optional).map((a) => a.name);
    console.error(
      `  ${t.name.padEnd(24)} declared ${t.declaredRequired}/${t.declaredArgs} required, engine wants ${t.engineRequired}   (lying optionals: ${optionalNames.join(", ")})`,
    );
  }
  await client.dispose();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
