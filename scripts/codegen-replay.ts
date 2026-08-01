/**
 * Codegen replay — re-run the decoder over bundles the sweep already captured.
 *
 * Maintainer tooling. The sweep is the ground truth, but it needs an instance,
 * takes minutes, and exports a slightly different set of workspaces every run —
 * so comparing two sweeps means intersecting their workspace sets, and forgetting
 * to has repeatedly turned "a workspace re-entered the run" into a phantom
 * regression. Replay removes the variable entirely: same bundles in, same
 * decoder, deterministic counts, seconds.
 *
 * Decode-side work belongs here. Confirm a finished change with a real sweep —
 * verification needs a live instance and replay cannot do it.
 *
 *   npm run codegen:sweep -- --out /tmp/swb --concurrency 4 --keep-bundles --no-verify
 *   npm run codegen:replay -- --dir /tmp/swb
 *
 * Flags:
 *   --dir <dir>       a sweep --out dir holding projects/<id>/bundle.json
 *                     (default /tmp/swb)
 *   --json <file>     write one JSON line per entry, for clustering
 *   --category <cat>  print every matching entry to stderr as it is found
 *
 * Env:
 *   SIDESTEP_PROVE_DIFF=<file>   works here exactly as it does in the sweep —
 *                                the decline dump comes along.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBundle } from "../src/codegen/index.js";
import { severityOf, type ReportEntry } from "../src/codegen/report.js";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const dir = join(flag("dir", "/tmp/swb")!, "projects");
const jsonOut = flag("json");
const showCategory = flag("category");

const counts = new Map<string, number>();
const rows: Array<ReportEntry & { workspace: string }> = [];
let workspaces = 0;
let failed = 0;

for (const entry of readdirSync(dir).sort()) {
  let bundle: { payload: Record<string, unknown> };
  try {
    bundle = JSON.parse(readFileSync(join(dir, entry, "bundle.json"), "utf8"));
  } catch {
    continue; // not a captured workspace — the sweep writes other files here too
  }
  workspaces++;
  let report;
  try {
    report = decodeBundle(bundle).report;
  } catch (e) {
    failed++;
    counts.set("sweep-failed", (counts.get("sweep-failed") ?? 0) + 1);
    console.error(`  ${entry}: decode threw — ${String(e)}`);
    continue;
  }
  for (const e of report.entries) {
    if (severityOf(e.category) === "info") continue;
    counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    rows.push({ workspace: entry, ...e });
    if (e.category === showCategory) {
      console.error(`  ${entry} ${e.object} ${e.path ?? ""} — ${e.detail}`);
    }
  }
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
for (const [category, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(6), category);
}
console.log(String(total).padStart(6), "TOTAL");
console.log(`\n${workspaces} workspaces replayed, ${failed} threw`);

if (jsonOut) {
  writeFileSync(jsonOut, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${rows.length} rows to ${jsonOut}`);
}
