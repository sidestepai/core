/**
 * `sidestep sandbox export --format <json|multidoc>` — hand back a portable
 * artifact for the workspace you're iterating on:
 *
 *   • `--format json`     compiles the LOCAL workspace to the JSON bundle payload
 *                         (the same bytes `validate`/`deploy` send) and writes a
 *                         `.json` file. No network — this is `sidestep export`
 *                         under the sandbox namespace, with a conventional path.
 *   • `--format multidoc` calls `GET /api:meta/sandbox/multidoc` on the caller's
 *                         singleton sandbox tenant and writes the returned
 *                         `text/x-xanoscript` body to a `.xs` file. This reflects
 *                         whatever is CURRENTLY DEPLOYED — run `sandbox deploy`
 *                         first ("once the workspace is on the sandbox").
 *
 * `env`/`records`/`draft` are intentionally unsupported: the multidoc call uses
 * the endpoint defaults (all `false`).
 *
 * Both formats default to writing `./sandbox.<ext>` in the cwd; `--name`
 * overrides the basename and `--path` the location (`--path -` → stdout).
 *
 * Node-only (fetch/fs + the OAuth stack) and lazily imported by the command
 * layer so the browser-safe authoring bundle never pulls it in.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportBundleJson, type ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { success, step } from "./ui.js";

/** The multidoc body can be large; bound the fetch like deploy/validate (not the 30s details bound). */
const MULTIDOC_TIMEOUT_MS = 120_000;

const MULTIDOC_PATH = "/api:meta/sandbox/multidoc";

/** Default output basename when `--name` is omitted — format-independent, no dependence on tenant naming. */
const DEFAULT_NAME = "sandbox";

/** Where the export should land: the stdout data channel, or an absolute file path. */
export type OutputTarget = { kind: "stdout" } | { kind: "file"; path: string };

/**
 * Resolve where an export writes, from the `--path`/`--name` flags and the
 * format's extension. Pure (aside from a directory-existence probe) so path
 * precedence is unit-testable without touching the compiler or `fetch`.
 *
 * Precedence:
 *   • `path === "-"`         → stdout.
 *   • no `path`              → `./<name>.<ext>` (cwd).
 *   • `path` is an existing dir, or ends in a path separator → `<path>/<name>.<ext>`.
 *   • otherwise              → `path` treated as a full file path, returned verbatim.
 *
 * `<name>` defaults to `sandbox`; `<ext>` is `json` or `xs`.
 */
export function resolveOutputTarget(opts: {
  path?: string;
  name?: string;
  ext: "json" | "xs";
}): OutputTarget {
  const { path, name, ext } = opts;
  if (path === "-") return { kind: "stdout" };

  const basename = `${name ?? DEFAULT_NAME}.${ext}`;

  if (path === undefined || path === "") {
    return { kind: "file", path: resolve(basename) };
  }

  // A trailing separator, or a path that already exists as a directory, means
  // "into this directory" — join the derived basename. Otherwise the path is a
  // full file target and is used verbatim (its own extension respected as-is).
  const endsWithSep = path.endsWith("/") || path.endsWith("\\");
  const isDir = statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  if (endsWithSep || isDir) {
    return { kind: "file", path: resolve(join(path, basename)) };
  }
  return { kind: "file", path: resolve(path) };
}

/**
 * Fetch the sandbox tenant's XanoScript multidoc over OAuth. A thin GET mirroring
 * `fetchSandboxDetails`' discipline (bearer + timeout + throw-with-body on non-2xx).
 * Sends no `env`/`records`/`include_draft` params, so the endpoint defaults apply.
 * Returns the raw `.xs` text; never parses it as JSON.
 */
export async function fetchSandboxMultidoc(auth: ResolvedAuth): Promise<string> {
  const url = new URL(MULTIDOC_PATH, auth.instance);
  const res = await fetch(url.href, {
    headers: {
      accept: "text/x-xanoscript",
      Authorization: `Bearer ${auth.access_token}`,
    },
    signal: AbortSignal.timeout(MULTIDOC_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`sandbox export (multidoc) failed (${res.status} ${res.statusText}):\n${text}`);
  }
  return text;
}

/** Produce the JSON bundle text: compile an entry `<file>` or read a pre-exported `--bundle <path>`. */
async function loadJsonBundle(args: ParsedArgs): Promise<string> {
  if (args.bundle !== undefined) {
    if (args.file !== undefined) throw new Error(`Pass either an entry <file> or --bundle <path>, not both.`);
    if (!existsSync(args.bundle)) {
      throw new Error(`${args.bundle} not found. Run \`sidestep export --out ${args.bundle}\` first.`);
    }
    return readFileSync(args.bundle, "utf8");
  }
  if (args.file !== undefined) return exportBundleJson(args);
  throw new Error(
    `Missing input for \`sandbox export --format json\`. Pass an entry <file> or --bundle <path>.`,
  );
}

/**
 * Produce the export content + its extension for the requested format.
 *   json     → local compile (no network); requires <file> or --bundle.
 *   multidoc → OAuth meta call; takes NO input (reads the deployed sandbox tenant).
 */
async function produce(args: ParsedArgs): Promise<{ content: string; ext: "json" | "xs" }> {
  if (args.format === "json") {
    return { content: await loadJsonBundle(args), ext: "json" };
  }
  // multidoc
  if (args.file !== undefined || args.bundle !== undefined) {
    throw new Error(
      `\`sandbox export --format multidoc\` takes no input — it exports the CURRENTLY DEPLOYED ` +
        `sandbox tenant. Run \`sidestep sandbox deploy\` first, then export.`,
    );
  }
  const auth = await getAccessToken(args);
  return { content: await fetchSandboxMultidoc(auth), ext: "xs" };
}

export async function runSandboxExportCommand(args: ParsedArgs): Promise<void> {
  if (args.format === undefined) {
    throw new Error(`Pass --format json|multidoc to \`sidestep sandbox export\`.`);
  }

  const { content, ext } = await produce(args);
  const target = resolveOutputTarget({ path: args.path, name: args.name, ext });

  if (target.kind === "stdout") {
    // stdout is the data channel (like `export`): the raw artifact, nothing else.
    process.stdout.write(content + "\n");
    return;
  }

  writeFileSync(target.path, content + "\n", "utf8");
  // Progress goes to stderr so stdout stays a clean data channel even when writing a file.
  step(`Exported ${args.format} → ${target.path}`);
  success(`Wrote ${target.path}`);
}
