/**
 * `sidestep <source> codegen <path>` — pull a workspace and write it as a
 * ready-to-run SideStep project.
 *
 *   sidestep workspace codegen <path>          your real workspace (the one your
 *                                              OAuth token is scoped to)
 *   sidestep sandbox codegen <path>            the singleton sandbox tenant
 *   sidestep ephemeral codegen <tenant> <path> a named ephemeral environment
 *   sidestep codegen <bundle.json> <path>      a bundle file already on disk
 *
 * All four share one core: get a bundle, `decodeBundle` it, write the project,
 * then verify. Only the first step differs, which is why the source is a small
 * tagged union rather than four commands.
 *
 * **The output is a project, not a loose tree.** It is the same scaffold
 * `sidestep init` writes — root `package.json`, `tsconfig.json`, `frontend/`,
 * the `build`/`xano:deploy` scripts — with the decoded workspace filling
 * `xano/` instead of a starter. So a pull is immediately runnable:
 *
 *   sidestep workspace codegen my-app && cd my-app && npm run build && npm run xano:deploy
 *
 * **`xano/` is disposable; the project around it is not.** Regenerating rewrites
 * that directory wholesale, which is why a re-run needs no `--force` (the
 * provenance marker proves the directory was machine-written) while a directory
 * holding anything else still does. And because the deploy path is a full
 * replace, the tree is only ever safe to deploy into an ephemeral or sandbox
 * environment — the generated READMEs say so unconditionally, and so does the
 * summary here.
 *
 * Verification (KTD-9) runs by default: the project that was just written is
 * loaded, exported, and diffed against the source bundle under `normalize()`.
 * `--no-verify` skips it. See `codegen/verify.ts` for why a proof-carrying
 * decoder still needs it.
 *
 * Node-only (fetch/fs + OAuth); lazily imported by the command layer so the
 * browser-safe authoring bundle never pulls it in.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { loadDefault, readVersion } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { decodeBundle, type GeneratedProject } from "../codegen/index.js";
import { reportMismatches, verifyBundles } from "../codegen/verify.js";
import type { ExportedBundle } from "../deploy/workspace-export.js";
import { exportWorkspaceBundle } from "../deploy/workspace-export.js";
import { detail, info, step, success, warn, blank, style, stdoutStyle } from "./ui.js";
import { projectShellFiles, sanitizeAppName } from "./init-command.js";
import {
  resolveAiPresets,
  scaffoldProject,
  XANO_DIR,
  type InstallOutcome,
  type ScaffoldFile,
} from "./scaffold.js";
import {
  describeOrigin,
  renderCodegenAppTsx,
  renderCodegenMarker,
  renderCodegenReadme,
  type CodegenOrigin,
  type TemplateVars,
} from "./init-templates.js";

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

/** A bundle plus what identifies where it came from, for the marker and README. */
interface SourcedBundle {
  readonly bundle: ExportedBundle;
  readonly origin: CodegenOrigin;
}

/** Read the bundle for a live source. Each arm is one meta call chain. */
async function fetchBundle(args: ParsedArgs, source: CodegenSource): Promise<SourcedBundle> {
  if (source.kind === "sandbox") {
    const auth = await getAccessToken(args);
    step("Reading the sandbox workspace");
    const { fetchSandboxBundle } = await import("./sandbox-export-command.js");
    return {
      bundle: await fetchSandboxBundle(auth),
      origin: { source: "sandbox", origin: auth.instance },
    };
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
    const { resolveLive, fetchEphemeralBundle } = await import("./ephemeral-command.js");
    // The gone/expired gate first — it is also what yields the env's base URL.
    const summary = await resolveLive(auth, auth.workspaceId, name);
    step(`Reading ephemeral "${name}"`);
    return {
      bundle: await fetchEphemeralBundle(auth, summary, name),
      origin: { source: "ephemeral", origin: name },
    };
  }
  const auth = await getAccessToken(args);
  const workspaceId = auth.workspaceId;
  step(`Reading workspace ${workspaceId}`);
  return {
    bundle: await exportWorkspaceBundle(auth, {
      base: auth.instance,
      workspaceId,
      label: "workspace export",
    }),
    origin: { source: "workspace", origin: String(workspaceId) },
  };
}

/**
 * Read the caller's real workspace.
 *
 * The workspace id is the one the credential is bound to — never a hard-coded 1
 * (instances number workspaces from their own sequence) and never a flag.
 */
export async function fetchWorkspaceBundle(auth: ResolvedAuth): Promise<ExportedBundle> {
  const workspaceId = auth.workspaceId;
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

/** The generated files that are not source, and where each belongs in a project. */
const GENERATED_TSCONFIG = "tsconfig.json";
const GENERATED_README = "README.md";

/**
 * Map the decoded tree into project-relative scaffold files.
 *
 * `decodeBundle` emits paths relative to wherever the tree is put — `index.ts`,
 * `_shared.ts`, `functions/signup.ts` — because it is pure and offline and has
 * no reason to know about a project layout. Placing it is the command's job:
 *
 * - Everything gains an `xano/` prefix.
 * - The generated `tsconfig.json` is dropped. The project's root tsconfig
 *   already covers `xano/`, and two tsconfigs in one project is a trap. (The
 *   generated one sets `verbatimModuleSyntax`, which the root does not — that
 *   direction is safe, since the printer already separates type-only imports.)
 * - The generated `README.md` — the decode report — becomes `xano/README.md`,
 *   next to the code it describes, leaving the root README for the project.
 */
function placeGeneratedFiles(project: GeneratedProject): ScaffoldFile[] {
  const out: ScaffoldFile[] = [];
  for (const file of project.files) {
    if (file.path === GENERATED_TSCONFIG) continue;
    const path =
      file.path === GENERATED_README
        ? `${XANO_DIR}/${GENERATED_README}`
        : `${XANO_DIR}/${file.path}`;
    out.push({ path, content: file.contents });
  }
  return out;
}

/** Workspace env var names carried by the bundle, for the README's warning. */
function envNames(payload: Record<string, unknown>): string[] {
  const env = payload.env;
  if (!Array.isArray(env)) return [];
  return env
    .map((e) => (e as { name?: unknown }).name)
    .filter((n): n is string => typeof n === "string" && n !== "");
}

/**
 * Load the project that was just written and export it, so it can be diffed
 * against the bundle it came from. Uses the same TS-loading path as every other
 * command, so a generated tree is loaded exactly the way `sidestep deploy` will.
 */
async function reexport(out: string): Promise<unknown> {
  const entry = join(out, XANO_DIR, "index.ts");
  const registry = (await loadDefault(entry)) as { export?: () => unknown } | undefined;
  if (typeof registry?.export !== "function") {
    throw new Error(
      `The generated tree at "${entry}" did not default-export a workspace registry — cannot verify it.`,
    );
  }
  return registry.export();
}

/**
 * Whether a load failure means "this project's dependencies are not installed"
 * rather than "this tree is broken".
 *
 * Deliberately narrow, and it has to look in two places. `loadDefault` does not
 * surface the resolution error directly: it routes `ERR_MODULE_NOT_FOUND` into
 * the tsx fallback, which — when `tsx` is also unresolvable, i.e. exactly the
 * uninstalled state — throws a *fresh* "requires `tsx`" error carrying the
 * original only on `cause`. So the chain is walked, and both shapes count.
 *
 * Anything else is a real failure and must stay one: a too-broad match here
 * would silently retire the round-trip check that is the whole point of KTD-9.
 */
export function isMissingDependencyError(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    const message = typeof e.message === "string" ? e.message : "";
    if (
      (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") &&
      message.includes("@sidestep/core")
    ) {
      return true;
    }
    // The tsx fallback's own "cannot recover" error — tsx is a scaffold
    // devDependency, so its absence is the uninstalled state too.
    if (/requires `tsx`/.test(message)) return true;
    cur = e.cause;
  }
  return false;
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

  const { bundle, origin } =
    source.kind === "file"
      ? { bundle: readBundleFile(fileArg!), origin: { source: "file", origin: fileArg! } as const }
      : await fetchBundle(args, source);

  const out = resolve(pathArg);
  const appName = sanitizeAppName(args.name ?? basename(out));
  const vars: TemplateVars = { appName, coreVersion: readVersion() };
  const presets = await resolveAiPresets(args.ai);

  const project = decodeBundle(bundle);
  const files: ScaffoldFile[] = [
    ...projectShellFiles(vars, {
      readme: renderCodegenReadme(vars, origin, envNames(bundle.payload ?? {})),
      app: renderCodegenAppTsx(vars, origin),
    }),
    ...placeGeneratedFiles(project),
    {
      path: `${XANO_DIR}/.sidestep-codegen.json`,
      content: renderCodegenMarker(vars, origin, new Date().toISOString()),
    },
  ];

  step(`Writing ${style.bold(appName)} to ${out}`);
  const scaffold = await scaffoldProject({
    targetDir: out,
    files,
    presets,
    appName,
    force: args.force,
    noInstall: args.noInstall,
    regenerable: true,
  });

  let verified: boolean | null = null;
  if (!args.noVerify) {
    step("Verifying the generated tree round-trips");
    try {
      const result = verifyBundles(bundle, await reexport(out));
      reportMismatches(project.report, result);
      verified = result.ok;
      // The decode report is written from the report object, so it has to be
      // re-rendered once verification has had its say — otherwise the file on
      // disk claims a clean run the CLI just contradicted.
      const readme = project.files.find((f) => f.path === GENERATED_README);
      if (readme && !result.ok) {
        writeFileSync(
          join(out, XANO_DIR, GENERATED_README),
          `${readme.contents.replace(/\n$/, "")}\n\n${project.report.renderMarkdown()}`,
          "utf8",
        );
      }
    } catch (err) {
      // "Dependencies are not installed" is the one load failure that is not the
      // tree's fault — but only when install did not actually report success.
      // An install that succeeded and then failed to load IS the tree's fault,
      // and downgrading that would turn the hard gate into a warning on the
      // default path (offline, registry hiccup, an unpublished version).
      if (scaffold.install !== "installed" && isMissingDependencyError(err)) {
        warn(unverifiedReason(scaffold.install));
      } else {
        throw err;
      }
    }
  }

  summarize(args, project, bundle, verified, out, origin, scaffold.install);

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

/** Why verification could not run, phrased as the thing to do about it. */
function unverifiedReason(install: InstallOutcome): string {
  const fix = `run \`npm install\` in the project and re-run codegen to check the round trip`;
  return install === "skipped"
    ? `Could not verify the round trip: dependencies are not installed (--no-install) — ${fix}.`
    : `Could not verify the round trip: \`npm install\` did not complete, so the tree could not be loaded — ${fix}.`;
}

/** Per-kind object counts, for the summary. */
function countBySection(payload: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(payload)
    .filter(([, section]) => Array.isArray(section) && section.length > 0)
    .map(([key, section]) => [key, (section as unknown[]).length] as [string, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The CLI summary: what was written, what did not round-trip, and what to run next. */
function summarize(
  args: ParsedArgs,
  project: GeneratedProject,
  bundle: ExportedBundle,
  verified: boolean | null,
  out: string,
  origin: CodegenOrigin,
  install: InstallOutcome,
): void {
  const s = stdoutStyle();
  const counts = countBySection(bundle.payload ?? {});
  info(`Decoded ${counts.map(([key, n]) => `${n} ${key}`).join(", ")} from ${describeOrigin(origin)}`);

  // Derived from the same computed report the README renders, so the two can
  // never disagree about how many problems there were. Severity comes from the
  // report itself rather than a category list restated here — that duplication
  // is exactly how a "problem" count drifts from what the entries actually say.
  const summary = project.report.summarize();
  const groups = summary.byCategory;
  const omitted = groups.find((g) => g.category === "expected-omission")?.count ?? 0;
  const problems = summary.bySeverity.error + summary.bySeverity.warning;
  const rendered = project.report.renderCli();
  if (rendered !== "") {
    // A run whose only entries are notices DID round-trip cleanly — saying
    // otherwise trains users to ignore the one header that matters.
    warn(
      problems > 0
        ? "Not everything round-tripped cleanly:"
        : "Round-tripped cleanly. Some values are deliberately not carried into the tree:",
    );
    process.stderr.write(`${rendered}\n`);
  }

  if (verified === null) {
    if (args.noVerify) warn("Skipped round-trip verification (--no-verify) — the tree is unchecked.");
  } else if (verified) {
    success(
      omitted > 0
        ? `Verified: re-exporting ${out} reproduces the source bundle, apart from ${omitted} deliberately omitted value${omitted === 1 ? "" : "s"} listed above`
        : `Verified: re-exporting ${out} reproduces the source bundle`,
    );
  } else {
    warn(`Verification FAILED — the objects listed above do not re-export as they were pulled.`);
  }

  blank();
  success("Project ready.");
  const cdHint = out === process.cwd() ? "" : `  cd ${args.positionals.at(-1)}\n`;
  detail(
    `Next steps:\n` +
      cdHint +
      (install === "installed" ? `` : `  npm install\n`) +
      `  sidestep login         # authenticate with Xano\n` +
      `  npm run build && npm run xano:deploy   # deploy → live ephemeral URL`,
  );
  detail(
    `${s.bold(`${XANO_DIR}/`)} is disposable and schema-only — re-running codegen rewrites it. ` +
      `Deploying is a FULL REPLACE, so send it only to an ephemeral or sandbox environment.`,
  );
}
