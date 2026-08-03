/**
 * Codegen sweep — run `codegen` over EVERY workspace on an instance and collect
 * every warning into one CSV.
 *
 * Maintainer tooling for finding decoder gaps at scale: point it at an instance
 * with a meta token, and it pulls each workspace, decodes it to a SideStep tree,
 * verifies the round trip, and appends one CSV row per report entry.
 *
 * Why not shell out to `sidestep workspace codegen` N times: a credential
 * addresses exactly ONE workspace by design, so the CLI physically cannot walk
 * an instance. The library underneath can — `exportWorkspaceBundle` takes the
 * workspace id explicitly — so the sweep drives that directly.
 *
 * Run (reads XANO_VALIDATE_INSTANCE / XANO_VALIDATE_TOKEN from `.env`, like the
 * other probes; needs `npm run build` first so generated trees can resolve
 * `@sidestep/core`):
 *
 *   npm run build
 *   npm run codegen:sweep -- --out /tmp/sweep
 *
 * Flags:
 *   --out <dir>          where projects + the CSV land (default ./codegen-sweep)
 *   --instance <url>     override XANO_VALIDATE_INSTANCE
 *   --only 3,7,12        just these workspace ids
 *   --limit <n>          first n workspaces only
 *   --concurrency <n>    parallel workspaces (default 4)
 *   --no-verify          skip the round-trip check (decode-only, much faster)
 *   --no-typecheck       skip the `tsc` pass over the generated trees
 *   --keep-bundles       also write each source bundle.json (big; for repros)
 *   --resume             skip workspaces that already finished in this out dir
 *
 * Env:
 *   SIDESTEP_PROVE_DIFF=<file>
 *       Append one JSON line per *declined* decode, naming the stored statement,
 *       the arm that declined, and why. This is what makes a `raw-fallback` row
 *       actionable: the CSV says a statement fell back, this says what stopped it.
 *
 *       Three record kinds, distinguished by the `diffs` entries:
 *         • key paths (`.context.x: encoded=… stored=…`) — a candidate was built
 *           and re-encoded, and these are the keys where it disagreed.
 *         • `ABORT: …` — the factory threw, so the recovered arguments were the
 *           wrong *shape* rather than the wrong value.
 *         • `GUARD: …` — `arm` is `"guard"`, and the decoder gave up before
 *           building anything. The label names the decoder and the guard, so
 *           these cluster directly without touching the key-path clustering.
 *
 *       Cluster the `diffs` arrays to find shared gaps — a handful of them account
 *       for the great majority of fallbacks. But note that a DECLINE IS NOT A
 *       FALLBACK: every candidate is recorded, including ones a later arm goes on
 *       to prove, so these counts are an upper bound on the CSV's. Cross-reference
 *       before drawing a conclusion.
 *
 * Output:
 *   <out>/warnings.csv   one row per report entry + one per hard failure
 *                        (severity: error | warning | notice, from the SDK's
 *                        own category catalog — see codegen/report.ts)
 *   <out>/summary.json   per-workspace status and counts
 *   <out>/projects/<id>-<slug>/  the generated tree for that workspace
 *
 * The generated trees are NOT full `sidestep init` scaffolds and are not
 * npm-installed — one shared `<out>/node_modules/@sidestep/core` symlink into
 * this repo is what makes them loadable, so verification stays as cheap as a
 * dynamic import.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { decodeBundle, type GeneratedProject } from "../src/codegen/index.js";
import type { ReportEntry } from "../src/codegen/index.js";
import { severityOf } from "../src/codegen/report.js";
import { reportMismatches, verifyBundles } from "../src/codegen/verify.js";
import { exportWorkspaceBundle } from "../src/deploy/workspace-export.js";
import type { ExportedBundle } from "../src/deploy/workspace-export.js";
import { resolveValidateConfig } from "../src/validate/config.js";

const REPO = resolve(import.meta.dirname, "..");
const LIST_TIMEOUT_MS = 30_000;

interface Options {
  out: string;
  instance: string | undefined;
  only: Set<number> | undefined;
  limit: number | undefined;
  concurrency: number;
  verify: boolean;
  typecheck: boolean;
  keepBundles: boolean;
  resume: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    out: "codegen-sweep",
    instance: undefined,
    only: undefined,
    limit: undefined,
    concurrency: 4,
    verify: true,
    typecheck: true,
    keepBundles: false,
    resume: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      return value;
    };
    if (arg === "--out") opts.out = next();
    else if (arg === "--instance") opts.instance = next();
    else if (arg === "--only") opts.only = new Set(next().split(",").map((s) => Number(s.trim())));
    else if (arg === "--limit") opts.limit = Number(next());
    else if (arg === "--concurrency") opts.concurrency = Math.max(1, Number(next()));
    else if (arg === "--no-verify") opts.verify = false;
    else if (arg === "--no-typecheck") opts.typecheck = false;
    else if (arg === "--keep-bundles") opts.keepBundles = true;
    else if (arg === "--resume") opts.resume = true;
    else throw new Error(`Unknown flag "${arg}". See the header of scripts/codegen-sweep.ts.`);
  }
  return opts;
}

/** One workspace as the meta list returns it. */
interface WorkspaceSummary {
  id: number;
  name: string;
}

/** `GET /api:meta/workspace` — every workspace the token can see. */
async function listWorkspaces(instance: string, token: string): Promise<WorkspaceSummary[]> {
  const res = await fetch(`${instance}/api:meta/workspace`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`workspace list failed (${res.status} ${res.statusText}):\n${text}`);
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`workspace list: response was not JSON:\n${text.slice(0, 400)}`);
  }
  // Tolerate both a bare array and a paged `{items:[…]}` envelope.
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { items?: unknown }).items)
      ? ((data as { items: unknown[] }).items)
      : [];
  const out: WorkspaceSummary[] = [];
  for (const raw of list) {
    const w = raw as { id?: unknown; name?: unknown };
    const id = typeof w.id === "number" ? w.id : Number(w.id);
    if (!Number.isFinite(id)) continue;
    out.push({ id, name: typeof w.name === "string" ? w.name : String(id) });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** A filesystem-safe, stable directory name for a workspace. */
function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "workspace" : cleaned.slice(0, 48);
}

/** Write a decoded tree, returning the entry path to import for verification. */
function writeProject(project: GeneratedProject, root: string): string {
  rmSync(root, { recursive: true, force: true });
  for (const file of project.files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents, "utf8");
  }
  return join(root, "index.ts");
}

/**
 * Best-effort "which generated file does this entry live in".
 *
 * The report identifies an object as `kind:name`; placement (`_shared.ts` vs
 * `functions/<symbol>.ts`) is decided inside the assembler and not exposed. So
 * the name is matched against the emitted `name:` literals rather than the
 * layout rules being restated here — wrong-file is impossible for unique names,
 * and a miss just leaves the column empty.
 */
function fileIndex(project: GeneratedProject): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of project.files) {
    if (!file.path.endsWith(".ts")) continue;
    for (const match of file.contents.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const name = match[1]!.replace(/\\(.)/g, "$1");
      if (!index.has(name)) index.set(name, file.path);
    }
  }
  return index;
}

/**
 * Type-check every generated tree, and report the ones that do not compile.
 *
 * The round trip cannot see this. Verification writes the tree, imports it, and
 * compares the re-export — and `tsx` strips types, so a tree full of type errors
 * imports and re-exports perfectly. Two real defects shipped through a green
 * sweep exactly that way: an `input.enum` carrying `list: {max: {}, min: {}}`
 * (the engine's other spelling of "no bounds", which the option type declares as
 * strings) and `fl.filter_null()` (stored with no argument, while the generated
 * signature demanded one). Both round-tripped byte-perfectly. Neither compiled.
 *
 * ONE `tsc` invocation over all of them, not one per workspace: the trees are
 * independent modules, so a single program covers them at a fraction of the cost
 * of N cold starts — the difference between seconds and half an hour on a
 * full-instance sweep.
 */
function typecheckProjects(out: string, projects: readonly string[]): string[] {
  if (projects.length === 0) return [];
  const configPath = join(out, "tsconfig.check.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
        },
        include: projects.map((dir) => `${dir}/**/*.ts`),
      },
      null,
      2,
    ),
    "utf8",
  );
  const res = spawnSync(
    process.execPath,
    [join(REPO, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", configPath],
    { encoding: "utf8", cwd: out },
  );
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return output.split("\n").filter((line) => /\.ts\(\d+,\d+\): error /.test(line));
}

/** `kind:name` → the object's name half (the report's own format). */
function objectName(object: string): string {
  const colon = object.indexOf(":");
  return colon === -1 ? object : object.slice(colon + 1);
}

const CSV_HEADER = [
  "workspace_id",
  "workspace_name",
  "severity",
  "category",
  "object",
  "path",
  "file",
  "detail",
  "project_dir",
].join(",");

function csvCell(value: string | number): string {
  const text = String(value).replace(/\r?\n/g, " ").trim();
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One workspace's outcome, for `summary.json` and the console. */
interface WorkspaceResult {
  id: number;
  name: string;
  dir: string;
  status: "ok" | "problems" | "failed";
  problems: number;
  informational: number;
  verified: boolean | null;
  error?: string;
  byCategory?: Record<string, number>;
}

/** Pull, decode, write, verify — one workspace. Never throws; failures become a row. */
async function sweepWorkspace(
  ws: WorkspaceSummary,
  opts: Options,
  config: { instance: string; token: string },
  csvPath: string,
): Promise<WorkspaceResult> {
  const dir = join(resolve(opts.out), "projects", `${ws.id}-${slug(ws.name)}`);
  const rows: string[] = [];
  const emit = (
    severity: string,
    category: string,
    object: string,
    path: string,
    file: string,
    detail: string,
  ): void => {
    rows.push(
      [ws.id, ws.name, severity, category, object, path, file, detail, dir].map(csvCell).join(","),
    );
  };

  const result: WorkspaceResult = {
    id: ws.id,
    name: ws.name,
    dir,
    status: "ok",
    problems: 0,
    informational: 0,
    verified: null,
  };

  try {
    const auth = { access_token: config.token, instance: config.instance, workspaceId: ws.id, credentialType: "token" as const };
    const bundle: ExportedBundle = await exportWorkspaceBundle(auth, {
      base: config.instance,
      workspaceId: ws.id,
      label: `workspace ${ws.id} export`,
    });
    const project = decodeBundle(bundle);
    const entry = writeProject(project, dir);

    // AFTER the tree is written, never before: `writeProject` clears the
    // directory first, so a bundle written ahead of it was deleted every time
    // and the flag silently produced nothing.
    if (opts.keepBundles) {
      writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle), "utf8");
    }

    if (opts.verify) {
      try {
        const mod = (await import(pathToFileURL(entry).href)) as { default?: { export?: () => unknown } };
        const registry = mod.default;
        if (typeof registry?.export !== "function") {
          throw new Error("the generated tree did not default-export a workspace registry");
        }
        const verified = verifyBundles(bundle, registry.export());
        // Folds mismatches (and deliberate omissions) into the same report the
        // decode produced, so the CSV has one shape for every finding.
        reportMismatches(project.report, verified);
        result.verified = verified.ok;
      } catch (err) {
        result.verified = false;
        emit("error", "verify-failed", "bundle", "", "", describeError(err));
      }
    }

    const index = fileIndex(project);

    // The CSV lists every SITE; the counts describe what a USER is shown. Those
    // are deliberately different now that the report coalesces some categories
    // per object: one workspace carries 48 blank bindings that the CLI prints as
    // 5 lines, and a maintainer chasing them still wants all 48 rows to grep.
    //
    // So the rows come from the raw entry log and the totals come from
    // `summarize()` — the same computation the CLI and the generated README
    // read. Counting rows for both is what made this tool report 172 problems
    // against the CLI's 125 on the same instance, which is exactly the
    // disagreement `summarize()` exists to make impossible.
    for (const e of project.report.entries as readonly ReportEntry[]) {
      emit(
        severityOf(e.category),
        e.category,
        e.object,
        e.path ?? "",
        index.get(objectName(e.object)) ?? "",
        e.detail,
      );
    }

    const byCategory: Record<string, number> = {};
    const summary = project.report.summarize();
    for (const group of summary.byCategory) byCategory[group.category] = group.count;
    result.informational += summary.bySeverity.notice;
    result.problems += summary.bySeverity.error + summary.bySeverity.warning;
    result.byCategory = byCategory;
    if (result.problems > 0 || result.verified === false) result.status = "problems";
    writeFileSync(join(dir, ".sweep-done.json"), JSON.stringify(result, null, 2), "utf8");
  } catch (err) {
    result.status = "failed";
    result.error = describeError(err);
    emit("error", "sweep-failed", "workspace", "", "", result.error);
  }

  if (rows.length > 0) appendFileSync(csvPath, `${rows.join("\n")}\n`, "utf8");
  return result;
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : "";
  return `${message}${cause}`.slice(0, 1000);
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Make `@sidestep/core` resolvable from every generated tree with ONE symlink at
 * the sweep root, instead of an `npm install` per workspace. Node walks up from
 * the tree's directory and finds it, so the projects stay throwaway.
 */
function linkCore(out: string): void {
  if (!existsSync(join(REPO, "dist/index.js"))) {
    throw new Error("dist/ is missing — run `npm run build` first, or the generated trees cannot be verified.");
  }
  const scope = join(out, "node_modules", "@sidestep");
  mkdirSync(scope, { recursive: true });
  const link = join(scope, "core");
  if (!existsSync(link)) symlinkSync(REPO, link, "dir");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = resolveValidateConfig(opts.instance === undefined ? {} : { instance: opts.instance });
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  linkCore(out);

  const csvPath = join(out, "warnings.csv");
  if (!existsSync(csvPath) || !opts.resume) writeFileSync(csvPath, `${CSV_HEADER}\n`, "utf8");

  console.error(`Listing workspaces on ${config.instance}…`);
  let workspaces = await listWorkspaces(config.instance, config.token);
  if (opts.only) workspaces = workspaces.filter((w) => opts.only!.has(w.id));
  if (opts.resume) {
    workspaces = workspaces.filter(
      (w) => !existsSync(join(out, "projects", `${w.id}-${slug(w.name)}`, ".sweep-done.json")),
    );
  }
  if (opts.limit !== undefined) workspaces = workspaces.slice(0, opts.limit);
  console.error(`${workspaces.length} workspace(s) to sweep → ${out}`);

  let done = 0;
  const results = await mapLimit(workspaces, opts.concurrency, async (ws) => {
    const result = await sweepWorkspace(ws, opts, config, csvPath);
    done++;
    const badge =
      result.status === "failed"
        ? `FAILED — ${result.error}`
        : `${result.problems} problem(s), ${result.informational} informational${result.verified === false ? ", ROUND-TRIP MISMATCH" : ""}`;
    console.error(`[${done}/${workspaces.length}] ws ${result.id} "${result.name}": ${badge}`);
    return result;
  });

  // Merge with any prior run's summary so `--resume` accumulates rather than truncates.
  const summaryPath = join(out, "summary.json");
  const prior: WorkspaceResult[] =
    opts.resume && existsSync(summaryPath)
      ? ((JSON.parse(readFileSync(summaryPath, "utf8")) as { workspaces?: WorkspaceResult[] }).workspaces ?? [])
      : [];
  const merged = [...prior.filter((p) => !results.some((r) => r.id === p.id)), ...results].sort((a, b) => a.id - b.id);

  const totals = merged.reduce(
    (acc, r) => ({
      problems: acc.problems + r.problems,
      informational: acc.informational + r.informational,
      failed: acc.failed + (r.status === "failed" ? 1 : 0),
      mismatched: acc.mismatched + (r.verified === false ? 1 : 0),
    }),
    { problems: 0, informational: 0, failed: 0, mismatched: 0 },
  );
  const byCategory: Record<string, number> = {};
  for (const r of merged) {
    for (const [category, n] of Object.entries(r.byCategory ?? {})) {
      byCategory[category] = (byCategory[category] ?? 0) + n;
    }
  }
  writeFileSync(
    summaryPath,
    JSON.stringify({ instance: config.instance, workspaces: merged, totals, byCategory }, null, 2),
    "utf8",
  );
  const writeSummary = (extra: Record<string, unknown>): void =>
    writeFileSync(
      summaryPath,
      JSON.stringify({ instance: config.instance, workspaces: merged, totals, byCategory, ...extra }, null, 2),
      "utf8",
    );

  // Type-check LAST, over every tree this run produced. A tree that does not
  // compile is unusable to the person who pulled it, and nothing earlier in the
  // sweep can see that — `tsx` strips types, so verification imports and
  // re-exports a broken tree perfectly.
  let typeErrors: string[] = [];
  if (opts.typecheck) {
    const dirs = merged
      .filter((r) => r.status !== "failed")
      .map((r) => join("projects", `${r.id}-${slug(r.name)}`))
      .filter((dir) => existsSync(join(out, dir)));
    console.error(`\nType-checking ${dirs.length} generated tree(s)…`);
    typeErrors = typecheckProjects(out, dirs);
  }

  console.error(
    `\nDone. ${merged.length} workspace(s): ${totals.problems} problem(s), ${totals.informational} informational, ` +
      `${totals.mismatched} round-trip mismatch(es), ${totals.failed} failed.`,
  );
  if (opts.typecheck) {
    console.error(
      typeErrors.length === 0
        ? `Type-check: every generated tree compiles.`
        : `Type-check: ${typeErrors.length} ERROR(S) — a pulled tree does not compile:`,
    );
    for (const line of typeErrors.slice(0, 40)) console.error(`  ${line}`);
    if (typeErrors.length > 40) console.error(`  …and ${typeErrors.length - 40} more`);
  }
  if (opts.typecheck) writeSummary({ typeErrors });
  console.error(`CSV:     ${csvPath}`);
  console.error(`Summary: ${summaryPath}`);
  // A tree that does not compile is a failure of the thing this tool exists to
  // produce, so it has to be visible to a caller that only reads the exit code.
  if (typeErrors.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
