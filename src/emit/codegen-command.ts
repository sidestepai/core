/**
 * `sidestep <source> codegen <path>` — pull a workspace and write it as readable
 * SideStep TypeScript.
 *
 *   sidestep workspace codegen <path>          your real workspace (the one your
 *                                              OAuth token is scoped to)
 *   sidestep sandbox codegen <path>            the singleton sandbox tenant
 *   sidestep ephemeral codegen <tenant> <path> a named ephemeral environment
 *   sidestep codegen <bundle.json> <path>      a bundle file already on disk
 *
 * All four share one core: get a bundle, `decodeBundle` it, write the tree, then
 * verify. Only the first step differs, which is why the source is a small tagged
 * union rather than four commands.
 *
 * **The generated tree is disposable.** Regenerating destroys anything edited in
 * place, so a non-empty target requires `--force`. And because the deploy path is
 * a full replace, the tree is only ever safe to deploy into an ephemeral or
 * sandbox environment — the generated README says so unconditionally, and so does
 * the summary here.
 *
 * Verification (KTD-9) runs by default: the tree that was just written is loaded,
 * exported, and diffed against the source bundle under `normalize()`. `--no-verify`
 * skips it. See `codegen/verify.ts` for why a proof-carrying decoder still needs it.
 *
 * Node-only (fetch/fs + OAuth); lazily imported by the command layer so the
 * browser-safe authoring bundle never pulls it in.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { loadDefault } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { decodeBundle, type GeneratedProject } from "../codegen/index.js";
import { reportMismatches, verifyBundles } from "../codegen/verify.js";
import type { ExportedBundle } from "../deploy/workspace-export.js";
import { exportWorkspaceBundle } from "../deploy/workspace-export.js";
import { resolveScopedWorkspaceId } from "../deploy/workspace.js";
import { detail, info, step, success, warn, stdoutStyle } from "./ui.js";

/** Which environment to read the bundle from. */
export type CodegenSource =
  /** The caller's real workspace on the instance their token is bound to. */
  | { kind: "workspace" }
  /** The singleton sandbox tenant. */
  | { kind: "sandbox" }
  /** A named ephemeral environment. */
  | { kind: "ephemeral" }
  /** A bundle JSON file already on disk — offline, no auth. */
  | { kind: "file" };

/** Read the bundle for a live source. Each arm is one meta call chain. */
async function fetchBundle(args: ParsedArgs, source: CodegenSource): Promise<ExportedBundle> {
  if (source.kind === "sandbox") {
    const auth = await getAccessToken(args);
    step("Reading the sandbox workspace");
    const { fetchSandboxBundle } = await import("./sandbox-export-command.js");
    return fetchSandboxBundle(auth);
  }
  if (source.kind === "ephemeral") {
    const name = args.positionals[0];
    if (name === undefined || name === "") {
      throw new Error(
        "`sidestep ephemeral codegen` needs a tenant name and an output path: " +
          "`sidestep ephemeral codegen <tenant> <path>`. Run `sidestep ephemeral list` to see them.",
      );
    }
    const auth = await getAccessToken(args);
    const { parentWorkspace, resolveLive, fetchEphemeralBundle } = await import(
      "./ephemeral-command.js"
    );
    const parentWorkspaceId = await parentWorkspace(args, auth);
    // The gone/expired gate first — it is also what yields the env's base URL.
    const summary = await resolveLive(auth, parentWorkspaceId, name);
    step(`Reading ephemeral "${name}"`);
    return fetchEphemeralBundle(auth, summary, name);
  }
  const auth = await getAccessToken(args);
  return fetchWorkspaceBundle(args, auth);
}

/**
 * Read the caller's real workspace.
 *
 * The workspace id is the one the OAuth token consented to — never a hard-coded
 * 1, since instances number workspaces from their own sequence. `--workspace`
 * overrides it for an account with access to several.
 */
export async function fetchWorkspaceBundle(
  args: ParsedArgs,
  auth: ResolvedAuth,
): Promise<ExportedBundle> {
  const workspaceId = args.workspace ?? (await resolveScopedWorkspaceId(auth));
  step(`Reading workspace ${workspaceId}`);
  return exportWorkspaceBundle(auth, {
    base: auth.instance,
    workspaceId,
    label: "workspace export",
  });
}

/** Read and parse a bundle JSON file, with errors a user can act on. */
function readBundleFile(path: string): ExportedBundle {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`No bundle file at "${absolute}".`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `"${absolute}" is not valid JSON. Pass a bundle written by \`sidestep export\` or \`sidestep <env> export\`.`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object" || !("payload" in parsed)) {
    throw new Error(
      `"${absolute}" has no \`payload\` — it is not a Xano bundle. ` +
        `Pass a bundle written by \`sidestep export\` or \`sidestep <env> export\`.`,
    );
  }
  return parsed as ExportedBundle;
}

/**
 * Resolve the output directory, refusing to clobber a non-empty one.
 *
 * `--force` is the opt-in, and it warns rather than proceeding quietly: the tree
 * has no merge story, so a regeneration over hand edits destroys them.
 */
function prepareOutDir(path: string, force: boolean): string {
  const out = resolve(path);
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length > 0 && !force) {
      throw new Error(
        `"${out}" is not empty. Codegen overwrites the tree it writes and preserves no hand edits — ` +
          `pass \`--force\` to write into it anyway, or choose an empty directory.`,
      );
    }
    if (entries.length > 0) {
      warn(`Writing into a non-empty directory — anything edited in place here will be lost.`);
    }
  }
  mkdirSync(out, { recursive: true });
  return out;
}

/** Write every generated file, creating the directories they sit in. */
function writeProject(project: GeneratedProject, out: string): void {
  for (const file of project.files) {
    const path = join(out, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents, "utf8");
  }
}

/**
 * Load the tree that was just written and export it, so it can be diffed against
 * the bundle it came from. Uses the same TS-loading path as every other command,
 * so a generated tree is loaded exactly the way `sidestep deploy` will load it.
 */
async function reexport(out: string): Promise<unknown> {
  const entry = join(out, "index.ts");
  const registry = (await loadDefault(entry)) as { export?: () => unknown } | undefined;
  if (typeof registry?.export !== "function") {
    throw new Error(
      `The generated tree at "${entry}" did not default-export a workspace registry — cannot verify it.`,
    );
  }
  return registry.export();
}

/** Per-kind object counts, for the summary. */
function countBySection(payload: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(payload)
    .filter(([, section]) => Array.isArray(section) && section.length > 0)
    .map(([key, section]) => [key, (section as unknown[]).length] as [string, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export async function runCodegenCommand(args: ParsedArgs, source: CodegenSource): Promise<void> {
  // `ephemeral codegen` takes the tenant first, so its path is the second
  // positional; every other form takes the path first.
  const outArg = source.kind === "ephemeral" ? args.positionals[1] : args.positionals[0];
  const fileArg = source.kind === "file" ? args.positionals[0] : undefined;
  const pathArg = source.kind === "file" ? args.positionals[1] : outArg;

  if (source.kind === "file" && (fileArg === undefined || fileArg === "")) {
    throw new Error("`sidestep codegen` needs a bundle file: `sidestep codegen <bundle.json> <path>`.");
  }
  if (pathArg === undefined || pathArg === "") {
    throw new Error(
      source.kind === "ephemeral"
        ? "`sidestep ephemeral codegen` needs an output path: `sidestep ephemeral codegen <tenant> <path>`."
        : `\`sidestep ${source.kind === "file" ? "codegen <bundle.json>" : `${source.kind} codegen`}\` needs an output path.`,
    );
  }

  const bundle =
    source.kind === "file" ? readBundleFile(fileArg!) : await fetchBundle(args, source);

  const out = prepareOutDir(pathArg, args.force);
  const project = decodeBundle(bundle);
  writeProject(project, out);
  step(`Wrote ${project.files.length} files → ${out}`);

  let verified: boolean | null = null;
  if (!args.noVerify) {
    step("Verifying the generated tree round-trips");
    const result = verifyBundles(bundle, await reexport(out));
    reportMismatches(project.report, result);
    verified = result.ok;
    // The README is written from the report, so it has to be re-rendered once
    // verification has had its say — otherwise the file on disk claims a clean
    // run the CLI just contradicted.
    const readme = project.files.find((f) => f.path === "README.md");
    if (readme && !result.ok) {
      writeFileSync(
        join(out, "README.md"),
        `${readme.contents.replace(/\n$/, "")}\n\n${project.report.renderMarkdown()}`,
        "utf8",
      );
    }
  }

  summarize(args, project, bundle, verified, out);

  // A failed verify is a hard failure, not a warning: the tree on disk does not
  // reproduce the workspace it came from, so anything built on it is built on a
  // silent divergence. The files are left in place to be inspected.
  if (verified === false) {
    throw new Error(
      `Round-trip verification failed for the tree at "${out}" — see the mismatches above. ` +
        `The files were written so you can inspect them; do not deploy them.`,
    );
  }
}

/** The CLI summary: what was written, what did not round-trip, and the boundaries. */
function summarize(
  args: ParsedArgs,
  project: GeneratedProject,
  bundle: ExportedBundle,
  verified: boolean | null,
  out: string,
): void {
  const s = stdoutStyle();
  const counts = countBySection(bundle.payload ?? {});
  info(`Decoded ${counts.map(([key, n]) => `${n} ${key}`).join(", ")}`);

  // Derived from the same computed report the README renders, so the two can
  // never disagree about how many problems there were.
  const groups = project.report.summarize().byCategory;
  const omitted = groups.find((g) => g.category === "expected-omission")?.count ?? 0;
  const problems = groups.reduce((n, g) => (g.category === "expected-omission" ? n : n + g.count), 0);
  const rendered = project.report.renderCli();
  if (rendered !== "") {
    // A run whose only entries are deliberate omissions DID round-trip cleanly —
    // saying otherwise trains users to ignore the one header that matters.
    warn(
      problems > 0
        ? "Not everything round-tripped cleanly:"
        : "Round-tripped cleanly. Some values are deliberately not carried into the tree:",
    );
    process.stderr.write(`${rendered}\n`);
  }

  if (verified === null) {
    warn("Skipped round-trip verification (--no-verify) — the tree is unchecked.");
  } else if (verified) {
    success(
      omitted > 0
        ? `Verified: re-exporting ${out} reproduces the source bundle, apart from ${omitted} deliberately omitted value${omitted === 1 ? "" : "s"} listed above`
        : `Verified: re-exporting ${out} reproduces the source bundle`,
    );
  } else {
    warn(`Verification FAILED — the objects listed above do not re-export as they were pulled.`);
  }

  detail(
    `This tree is disposable and schema-only. Deploying it is a FULL REPLACE, so send it only ` +
      `to an ephemeral or sandbox environment: ${s.cyan(`sidestep deploy ${out}/index.ts`)}`,
  );
  if (args.noVerify) detail("Re-run without `--no-verify` to check the round trip.");
}
