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
 *   --refs <file>     write the degraded-reference counts, for before/after
 *                     comparison across a change to file layout
 *   --category <cat>  print every matching entry to stderr as it is found
 *
 * Env:
 *   SIDESTEP_PROVE_DIFF=<file>   works here exactly as it does in the sweep —
 *                                the decline dump comes along.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBundle, type GeneratedFile } from "../src/codegen/index.js";
import { type ReportEntry } from "../src/codegen/report.js";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** The comment `refConstStatements` puts above a file's hoisted ref consts. */
const REF_BLOCK_MARKER = "// References to objects declared below";

/**
 * Count the references a file could NOT emit as a symbol.
 *
 * A reference degrades to a hoisted `{name, guid}` const for one of three
 * reasons: the object refers to itself, an intra-file cycle put the target below
 * the referrer, or importing the target would close a cross-file cycle. Only the
 * last two move when file layout moves, so they are counted apart from the first.
 *
 * `inFile` is "the target is declared in this same file" — self-reference and
 * intra-file cycle both land there, and both shrink as a layout change spreads
 * objects across more files. `crossFile` is the cross-file back edge, which grows
 * for the same reason. The TOTAL is the number that must not rise: it is the
 * count of references that ship as an opaque guid instead of a real binding.
 *
 * Read off the emitted source rather than instrumented into the decoder, because
 * the printer is deterministic (see `src/codegen/print.ts`) and the artifact is
 * what actually ships. Nothing in `src/` changes to support this measurement.
 */
function countDegradedRefs(files: readonly GeneratedFile[]): { inFile: number; crossFile: number } {
  let inFile = 0;
  let crossFile = 0;
  for (const file of files) {
    const lines = file.contents.split("\n");
    const start = lines.findIndex((l) => l.startsWith(REF_BLOCK_MARKER));
    if (start === -1) continue;
    // Every `export const <symbol> =` in this file — the bindings a hoisted ref
    // could be standing in for without needing an import.
    const declared = new Set<string>();
    for (const line of lines) {
      const m = /^export const (\w+) =/.exec(line);
      if (m) declared.add(m[1]!);
    }
    // The block runs from the marker to the first blank line after it.
    for (let i = start + 1; i < lines.length && lines[i] !== ""; i += 1) {
      // `<symbol>Ref`, or `<symbol>Ref_2` when that name was already taken. The
      // greedy `\w+` keeps a symbol's own `_2` suffix (`posts_2Ref` → `posts_2`).
      const m = /^const (\w+)Ref(?:_\d+)? = \{$/.exec(lines[i]!);
      if (!m) continue;
      if (declared.has(m[1]!)) inFile += 1;
      else crossFile += 1;
    }
  }
  return { inFile, crossFile };
}

const dir = join(flag("dir", "/tmp/swb")!, "projects");
const jsonOut = flag("json");
const refsOut = flag("refs");
const showCategory = flag("category");

const counts = new Map<string, number>();
const rows: Array<ReportEntry & { workspace: string }> = [];
let workspaces = 0;
let failed = 0;
/** Workspaces carrying at least one entry a user is asked to act on. */
let workspacesWithProblems = 0;
const bySeverity = { error: 0, warning: 0, notice: 0 };
/** Degraded references (see `countDegradedRefs`), the layout-fidelity metric. */
const degraded = { inFile: 0, crossFile: 0 };
const degradedByWorkspace: Array<{ workspace: string; inFile: number; crossFile: number }> = [];

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
    const project = decodeBundle(bundle);
    report = project.report;
    const refs = countDegradedRefs(project.files);
    degraded.inFile += refs.inFile;
    degraded.crossFile += refs.crossFile;
    if (refs.inFile + refs.crossFile > 0) degradedByWorkspace.push({ workspace: entry, ...refs });
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
console.log(
  `\n${String(degraded.inFile + degraded.crossFile).padStart(6)} DEGRADED REFS ` +
    `(${degraded.inFile} same-file, ${degraded.crossFile} cross-file) ` +
    `across ${degradedByWorkspace.length} workspaces`,
);

if (refsOut) {
  writeFileSync(
    refsOut,
    JSON.stringify(
      {
        total: degraded.inFile + degraded.crossFile,
        inFile: degraded.inFile,
        crossFile: degraded.crossFile,
        workspaces: degradedByWorkspace.sort((a, b) => a.workspace.localeCompare(b.workspace)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote degraded-ref baseline to ${refsOut}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${rows.length} rows to ${jsonOut}`);
}
