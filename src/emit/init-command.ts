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
 * Node-only (node:fs + child_process for the optional install + a readline
 * prompt); lazily imported from the CLI dispatcher so the browser-safe authoring
 * bundle never pulls it in.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { ParsedArgs } from "./cli.js";
import { readVersion } from "./cli.js";
import { step, success, warn, info, detail, blank, style } from "./ui.js";
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
import { AI_PRESETS, presetFilePath, renderPreset, type AiPreset } from "./init-ai-presets.js";

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
 * Validate `--ai` preset names, returning the de-duplicated selection. `none`
 * clears the selection (explicit opt-out). Unknown presets are a hard error.
 */
export function resolveAiFlags(flags: string[]): AiPreset[] {
  const selected: AiPreset[] = [];
  for (const raw of flags) {
    const p = raw.toLowerCase();
    if (p === "none") return [];
    if ((AI_PRESETS as readonly string[]).includes(p)) {
      if (!selected.includes(p as AiPreset)) selected.push(p as AiPreset);
    } else {
      throw new Error(
        `Unknown --ai preset "${raw}". Valid presets: ${AI_PRESETS.join(", ")}, none.`,
      );
    }
  }
  return selected;
}

/** The scaffold file set, resolved from the target dir + template vars. */
function buildFileSet(vars: TemplateVars): Array<{ path: string; content: string }> {
  return [
    { path: "package.json", content: renderPackageJson(vars) },
    { path: "tsconfig.json", content: renderTsconfig() },
    { path: "vite.config.ts", content: renderViteConfig() },
    { path: ".gitignore", content: renderGitignore() },
    { path: ".env.example", content: renderEnvExample() },
    { path: "README.md", content: renderReadme(vars) },
    { path: "xano/index.ts", content: renderXanoIndex(vars) },
    { path: "xano/EXAMPLE.md", content: renderXanoExampleMd(vars) },
    { path: "frontend/index.html", content: renderIndexHtml(vars) },
    { path: "frontend/src/main.tsx", content: renderMainTsx() },
    { path: "frontend/src/App.tsx", content: renderAppTsx(vars) },
    { path: "frontend/src/index.css", content: renderIndexCss() },
    { path: "frontend/src/lib/api.ts", content: renderApiTs() },
  ];
}

/** Whether a directory exists and holds anything other than nothing (dotfiles included). */
function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Prompt (in a TTY) for which AI presets to scaffold. Returns the selection; an
 * empty answer means "none". Never called in non-interactive mode.
 */
async function promptAiPresets(): Promise<AiPreset[]> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      `\nSet up AI-assistant instructions? (optional)\n` +
        AI_PRESETS.map((p, i) => `  ${i + 1}) ${p} → ${presetFilePath(p)}`).join("\n") +
        `\n`,
    );
    const answer = await rl.question(
      `Enter numbers/names (comma-separated), or leave blank for none: `,
    );
    const tokens = answer
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== "");
    const selected: AiPreset[] = [];
    for (const tok of tokens) {
      const byIndex = Number.parseInt(tok, 10);
      const preset =
        Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= AI_PRESETS.length
          ? AI_PRESETS[byIndex - 1]
          : (AI_PRESETS as readonly string[]).includes(tok)
            ? (tok as AiPreset)
            : undefined;
      if (preset && !selected.includes(preset)) selected.push(preset);
    }
    return selected;
  } finally {
    rl.close();
  }
}

export async function runInitCommand(args: ParsedArgs): Promise<void> {
  const targetArg = args.positionals[0] ?? ".";
  const targetDir = resolve(targetArg);
  const appName = sanitizeAppName(args.name ?? basename(targetDir));

  // Emptiness guard: never clobber an existing project unless --force.
  if (isNonEmptyDir(targetDir) && !args.force) {
    throw new Error(
      `Target directory ${targetDir} is not empty. ` +
        `Re-run with --force to scaffold into it anyway.`,
    );
  }

  // Resolve AI presets: --ai flags win; else prompt in a TTY; else none.
  let presets: AiPreset[];
  if (args.ai.length > 0) {
    presets = resolveAiFlags(args.ai);
  } else if (process.stdin.isTTY && process.stderr.isTTY) {
    presets = await promptAiPresets();
  } else {
    presets = [];
  }

  const vars: TemplateVars = { appName, coreVersion: readVersion() };

  step(`Scaffolding ${style.bold(appName)} in ${targetDir}`);

  const files = buildFileSet(vars);
  for (const preset of presets) {
    files.push({ path: presetFilePath(preset), content: renderPreset(preset, appName) });
  }

  for (const file of files) {
    const full = join(targetDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, "utf8");
    detail(file.path);
  }
  success(`Wrote ${files.length} files`);
  if (presets.length > 0) {
    info(`AI instructions: ${presets.map(presetFilePath).join(", ")}`);
  }

  // Optional install — a failure is non-fatal: the scaffold is still valid.
  if (!args.noInstall) {
    step("Installing dependencies (npm install)");
    // On Windows the npm launcher is `npm.cmd`; a bare `npm` isn't found without
    // a shell (mirrors the platform handling in auth/loopback.ts).
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const res = spawnSync(npmCmd, ["install"], { cwd: targetDir, stdio: "inherit" });
    if (res.status === 0) {
      success("Dependencies installed");
    } else {
      warn(`npm install did not complete — run it yourself in ${targetDir}.`);
    }
  }

  // Next steps.
  blank();
  success("Project ready.");
  const cdHint = targetDir === process.cwd() ? "" : `  cd ${targetArg}\n`;
  detail(
    `Next steps:\n` +
      cdHint +
      (args.noInstall ? `  npm install\n` : ``) +
      `  npm run dev            # run the frontend\n` +
      `  sidestep login         # authenticate with Xano\n` +
      `  npm run build && npm run xano:deploy   # deploy → live ephemeral URL`,
  );
}
