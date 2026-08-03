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
import { type ReportEntry } from "../src/codegen/report.js";

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
/** Workspaces carrying at least one entry a user is asked to act on. */
let workspacesWithProblems = 0;
const bySeverity = { error: 0, warning: 0, notice: 0 };

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
  // Counted from `summarize()`, not from the raw entry log, because that is what
  // a user is shown — it applies the report's own per-object coalescing, so a
  // number here cannot claim a workspace is noisier than its CLI output is.
  // (The old `severityOf(...) === "info"` guard never fired: `info` is not one
  // of the three severities, so every entry fell through it.)
  const summary = report.summarize();
  for (const group of summary.byCategory) {
    counts.set(group.category, (counts.get(group.category) ?? 0) + group.count);
    for (const e of group.entries) {
      rows.push({ workspace: entry, ...e });
      if (group.category === showCategory) {
        console.error(`  ${entry} ${e.object} ${e.path ?? ""} — ${e.detail}`);
      }
    }
  }
  for (const severity of ["error", "warning", "notice"] as const) {
    bySeverity[severity] += summary.bySeverity[severity];
  }
  if (summary.bySeverity.error + summary.bySeverity.warning > 0) workspacesWithProblems++;
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
for (const [category, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(6), category);
}
console.log(String(total).padStart(6), "TOTAL");
console.log(
  `\n${String(bySeverity.error + bySeverity.warning).padStart(6)} ERROR+WARN ` +
    `(${bySeverity.error} error, ${bySeverity.warning} warning), ${bySeverity.notice} notice`,
);
console.log(
  `\n${workspaces} workspaces replayed, ${failed} threw, ` +
    `${workspacesWithProblems} carry at least one error or warning`,
);

if (jsonOut) {
  writeFileSync(jsonOut, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${rows.length} rows to ${jsonOut}`);
}
