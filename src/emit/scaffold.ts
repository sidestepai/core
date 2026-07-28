/**
 * The scaffold engine shared by `sidestep init` and `sidestep <source> codegen`.
 *
 * Both commands answer the same question — "give me a sidestep project" — and
 * differ only in what fills `xano/`: an empty starter, or a workspace decoded
 * from a Xano bundle. Everything else (the overwrite decision, writing the tree,
 * resolving AI-assistant presets, the optional `npm install`) is one code path
 * here, so a script added to the scaffold's `package.json` cannot land in one
 * command and not the other.
 *
 * The one asymmetry is `regenerable`. A codegen project's `xano/` is
 * machine-written and disposable, which earns it two behaviours `init` must not
 * have: a re-run refreshes that directory without demanding `--force`, and a
 * `--force` full scaffold clears it first so files from a previous tree cannot
 * survive as orphans (they would still sit inside the root tsconfig's `include`
 * and break `npm run build`).
 *
 * Node-only (node:fs + child_process + a readline prompt); imported lazily by
 * the command modules so the browser-safe authoring bundle never pulls it in.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { detail, step, success, warn } from "./ui.js";
import { AI_PRESETS, presetFilePath, renderPreset, type AiPreset } from "./init-ai-presets.js";

/** The backend directory every scaffolded project keeps its sidestep source in. */
export const XANO_DIR = "xano";

/**
 * Provenance for a codegen-written tree, and the signal that `xano/` may be
 * refreshed without `--force`. Lives inside `xano/` so the delete-and-rewrite
 * branch is self-cleaning — there is no marker left behind pointing at a
 * directory that no longer matches it.
 */
export const CODEGEN_MARKER = `${XANO_DIR}/.sidestep-codegen.json`;

/**
 * Files under `xano/` that survive a refresh.
 *
 * `xano.lock` is not a hand edit — `sidestep deploy`/`export --lock` place it
 * beside the entry file, which for a scaffolded project is `xano/index.ts`, i.e.
 * inside the directory a refresh removes. It pins object identities across
 * deploys, so losing it silently re-derives guids for objects that already
 * exist. Everything else under `xano/` really is disposable.
 */
const PRESERVED_ON_REFRESH: readonly string[] = ["xano.lock"];

/** One file to write, at a path relative to the project root. */
export interface ScaffoldFile {
  /** Relative POSIX path, e.g. `xano/index.ts`. */
  readonly path: string;
  readonly content: string;
}

/** What a scaffold run is allowed to do to the target directory. */
export type OverwriteMode =
  /** Write the whole project. */
  | "full"
  /** Rewrite `xano/` only, leaving the project shell in place. */
  | "refresh-xano"
  /** Refuse — the directory holds something this command did not write. */
  | "refuse";

/** Whether dependencies were installed, and why not when they were not. */
export type InstallOutcome = "installed" | "failed" | "skipped";

export interface ScaffoldOptions {
  /** Absolute path to the project root. */
  readonly targetDir: string;
  readonly files: readonly ScaffoldFile[];
  readonly presets: readonly AiPreset[];
  readonly appName: string;
  readonly force: boolean;
  readonly noInstall: boolean;
  /**
   * True for `codegen`: `xano/` is machine-written, so it may be refreshed in
   * place and is cleared before a full (re)scaffold.
   */
  readonly regenerable: boolean;
}

export interface ScaffoldResult {
  readonly mode: Exclude<OverwriteMode, "refuse">;
  readonly written: readonly string[];
  readonly install: InstallOutcome;
}

/** Whether a directory exists and holds anything at all (dotfiles included). */
export function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Decide what a run may overwrite, before a single byte is written.
 *
 * The marker is the whole basis for the no-`--force` refresh: its presence is
 * proof the directory's `xano/` was machine-written and already carries the
 * "regenerating overwrites this" warning. A directory holding anything else is
 * refused exactly as before.
 */
export function decideOverwrite(
  targetDir: string,
  opts: { force: boolean; regenerable: boolean },
): OverwriteMode {
  if (!isNonEmptyDir(targetDir)) return "full";
  if (opts.regenerable && existsSync(join(targetDir, CODEGEN_MARKER))) return "refresh-xano";
  return opts.force ? "full" : "refuse";
}

/** Read a previous run's marker, or `null` when there is none / it is unreadable. */
export function readMarker(targetDir: string): Record<string, unknown> | null {
  const path = join(targetDir, CODEGEN_MARKER);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A corrupt marker still proves the directory was machine-written; the
    // overwrite decision only checks existence, so this is not fatal.
    return null;
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

/**
 * Validate `--ai` preset names, returning the de-duplicated selection. `none`
 * clears the selection (explicit opt-out). Unknown presets are a hard error.
 */
export function resolveAiFlags(flags: readonly string[]): AiPreset[] {
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

/** `--ai` flags win; otherwise prompt in a TTY; otherwise none. */
export async function resolveAiPresets(flags: readonly string[]): Promise<AiPreset[]> {
  if (flags.length > 0) return resolveAiFlags(flags);
  if (process.stdin.isTTY && process.stderr.isTTY) return promptAiPresets();
  return [];
}

/** Remove `xano/`, carrying the files that are not ours to destroy back over. */
function clearXanoDir(targetDir: string): void {
  const xanoDir = join(targetDir, XANO_DIR);
  if (!existsSync(xanoDir)) return;
  const kept: Array<{ path: string; contents: Buffer }> = [];
  for (const name of PRESERVED_ON_REFRESH) {
    const path = join(xanoDir, name);
    if (existsSync(path)) kept.push({ path, contents: readFileSync(path) });
  }
  rmSync(xanoDir, { recursive: true, force: true });
  for (const file of kept) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
  }
}

/** Write one file, creating the directories it sits in. */
function writeFile(targetDir: string, file: ScaffoldFile): void {
  const full = join(targetDir, file.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, file.content, "utf8");
}

/**
 * Install dependencies. A failure is non-fatal — the scaffold is still valid —
 * but the outcome is returned rather than swallowed, because `codegen` needs it:
 * verification loads the written tree, and "install failed" is the difference
 * between "cannot verify yet" and "the tree is broken".
 */
function install(targetDir: string): InstallOutcome {
  step("Installing dependencies (npm install)");
  // On Windows the npm launcher is `npm.cmd`; a bare `npm` isn't found without
  // a shell (mirrors the platform handling in auth/loopback.ts).
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, ["install"], { cwd: targetDir, stdio: "inherit" });
  if (res.status === 0) {
    success("Dependencies installed");
    return "installed";
  }
  warn(`npm install did not complete — run it yourself in ${targetDir}.`);
  return "failed";
}

/**
 * Write a project into `targetDir`: decide, clear, write, install.
 *
 * Throws before writing anything when the target holds something this command
 * did not write and `--force` was not passed.
 */
export async function scaffoldProject(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const { targetDir, regenerable, force } = opts;
  const mode = decideOverwrite(targetDir, { force, regenerable });
  if (mode === "refuse") {
    throw new Error(
      `Target directory ${targetDir} is not empty. ` +
        `Re-run with --force to scaffold into it anyway.`,
    );
  }

  const files: ScaffoldFile[] = [...opts.files];
  if (mode === "full") {
    for (const preset of opts.presets) {
      files.push({ path: presetFilePath(preset), content: renderPreset(preset, opts.appName) });
    }
    // A previous tree's files would survive an in-place overwrite and stay inside
    // the root tsconfig's `include`, so `npm run build` would typecheck orphans
    // importing symbols the new barrel no longer exports.
    if (regenerable) clearXanoDir(targetDir);
  } else {
    clearXanoDir(targetDir);
  }

  const writing =
    mode === "refresh-xano"
      ? files.filter((f) => f.path === XANO_DIR || f.path.startsWith(`${XANO_DIR}/`))
      : files;

  mkdirSync(targetDir, { recursive: true });
  for (const file of writing) {
    writeFile(targetDir, file);
    detail(file.path);
  }
  success(
    mode === "refresh-xano"
      ? `Refreshed ${XANO_DIR}/ — ${writing.length} files (the rest of the project was left alone)`
      : `Wrote ${writing.length} files`,
  );

  // A refresh into a project whose dependencies are already installed has
  // nothing to install; a first run always does, because verification (and
  // `npm run build`) need them.
  const alreadyInstalled = existsSync(join(targetDir, "node_modules"));
  const outcome: InstallOutcome = opts.noInstall
    ? "skipped"
    : mode === "refresh-xano" && alreadyInstalled
      ? "skipped"
      : install(targetDir);

  return { mode, written: writing.map((f) => f.path), install: outcome };
}

/** Resolve a target-directory argument to an absolute path. */
export function resolveTarget(arg: string): string {
  return resolve(arg);
}
