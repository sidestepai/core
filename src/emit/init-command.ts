/**
 * `sidestep init [<dir>]` — scaffold a ready-to-run sidestep project: a Vite +
 * React frontend under `frontend/` and a sidestep-authored backend under `xano/`,
 * wired with `dev`/`build`/`xano:export`/`xano:deploy` scripts. The starter
 * backend is empty but valid (it compiles and deploys with zero domain code);
 * the walkthrough for the first table/endpoint lives in comments and
 * `xano/EXAMPLE.md`.
 *
 * AI-assistant instruction files (CLAUDE.md / AGENTS.md / Cursor rules) are NOT
 * written by default. `--ai <preset>` selects them non-interactively; in a TTY
 * with no `--ai` flag, `init` prompts. `--ai none` opts out explicitly.
 *
 * The mechanics — the overwrite decision, writing the tree, resolving presets,
 * the optional install — live in `scaffold.ts`, shared with `codegen`. This
 * module contributes the starter file set and the epilogue.
 *
 * Node-only; lazily imported from the CLI dispatcher so the browser-safe
 * authoring bundle never pulls it in.
 */
import { basename, resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { readVersion } from "./cli.js";
import { success, detail, blank, style, step, info } from "./ui.js";
import { resolveAiPresets, scaffoldProject, type ScaffoldFile } from "./scaffold.js";
import { presetFilePath } from "./init-ai-presets.js";
import {
  renderPackageJson,
  renderTsconfig,
  renderViteConfig,
  renderIndexHtml,
  renderGitignore,
  renderEnvExample,
  renderReadme,
  renderXanoIndex,
  renderXanoExampleMd,
  renderMainTsx,
  renderAppTsx,
  renderIndexCss,
  renderApiTs,
  type TemplateVars,
} from "./init-templates.js";

// Re-exported for the CLI and for callers that only import this module.
export { resolveAiFlags } from "./scaffold.js";

/**
 * Turn a raw name (a directory basename or `--name`) into a valid npm package
 * name: lowercase, non-alphanumerics collapsed to hyphens, edges trimmed.
 * Falls back to `app` when nothing usable survives.
 */
export function sanitizeAppName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name === "" ? "app" : name;
}

/**
 * The project shell both `init` and `codegen` write — everything outside
 * `xano/`. Shared so the two commands cannot drift on scripts, tsconfig, or the
 * frontend contract.
 *
 * `readme` and `app` are supplied by the caller: `init` addresses someone about
 * to author a backend, `codegen` someone who just pulled one, and the two want
 * different first paragraphs.
 */
export function projectShellFiles(
  vars: TemplateVars,
  parts: { readme: string; app: string },
): ScaffoldFile[] {
  return [
    { path: "package.json", content: renderPackageJson(vars) },
    { path: "tsconfig.json", content: renderTsconfig() },
    { path: "vite.config.ts", content: renderViteConfig() },
    { path: ".gitignore", content: renderGitignore() },
    { path: ".env.example", content: renderEnvExample() },
    { path: "README.md", content: parts.readme },
    { path: "frontend/index.html", content: renderIndexHtml(vars) },
    { path: "frontend/src/main.tsx", content: renderMainTsx() },
    { path: "frontend/src/App.tsx", content: parts.app },
    { path: "frontend/src/index.css", content: renderIndexCss() },
    { path: "frontend/src/lib/api.ts", content: renderApiTs() },
  ];
}

/** The `init` file set: the shared shell plus the empty-but-valid starter backend. */
function buildFileSet(vars: TemplateVars): ScaffoldFile[] {
  return [
    ...projectShellFiles(vars, { readme: renderReadme(vars), app: renderAppTsx(vars) }),
    { path: "xano/index.ts", content: renderXanoIndex(vars) },
    { path: "xano/EXAMPLE.md", content: renderXanoExampleMd(vars) },
  ];
}

export async function runInitCommand(args: ParsedArgs): Promise<void> {
  const targetArg = args.positionals[0] ?? ".";
  const targetDir = resolve(targetArg);
  const appName = sanitizeAppName(args.name ?? basename(targetDir));
  const presets = await resolveAiPresets(args.ai);
  const vars: TemplateVars = { appName, coreVersion: readVersion() };

  step(`Scaffolding ${style.bold(appName)} in ${targetDir}`);

  const result = await scaffoldProject({
    targetDir,
    files: buildFileSet(vars),
    presets,
    appName,
    force: args.force,
    noInstall: args.noInstall,
    // An `init` project's `xano/` is hand-authored, never machine-written: it is
    // not refreshable, and `--force` must not clear it.
    regenerable: false,
  });

  if (presets.length > 0) {
    info(`AI instructions: ${presets.map(presetFilePath).join(", ")}`);
  }

  blank();
  success("Project ready.");
  const cdHint = targetDir === process.cwd() ? "" : `  cd ${targetArg}\n`;
  detail(
    `Next steps:\n` +
      cdHint +
      (result.install === "installed" ? `` : `  npm install\n`) +
      `  npm run dev            # run the frontend\n` +
      `  sidestep login         # authenticate with Xano\n` +
      `  npm run build && npm run xano:deploy   # deploy → live ephemeral URL`,
  );
}
