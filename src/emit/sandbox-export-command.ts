/**
 * `sidestep sandbox export [--format <json|multidoc>]` — export the workspace
 * CURRENTLY DEPLOYED to your singleton sandbox tenant. Both formats are pure
 * OAuth meta calls against the sandbox: no local file, no compile step, so a
 * bare `sidestep sandbox export` just works (run `sandbox deploy` first).
 *
 *   • `--format json`     (default) exports the sandbox workspace as the JSON
 *                         bundle — the same `packageExport` shape `deploy` sends —
 *                         and writes a `.json` file. It reads the deployed tenant
 *                         over the meta API (like `sidestep validate`), NOT the
 *                         local package: sandbox/me → the tenant's workspace
 *                         export → decode → JSON.
 *   • `--format multidoc` calls `GET /api:meta/sandbox/multidoc` and writes the
 *                         returned `text/x-xanoscript` body to a `.xs` file.
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
import { statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { sandboxBaseUrl } from "./sandbox-details-command.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import { success, step } from "./ui.js";

/** Bound each sandbox call — the multidoc body and workspace archive can both be large. */
const SANDBOX_TIMEOUT_MS = 120_000;

const MULTIDOC_PATH = "/api:meta/sandbox/multidoc";
const SANDBOX_ME_PATH = "/api:meta/sandbox/me";

/** Default output basename when `--name` is omitted — format-independent, no dependence on tenant naming. */
const DEFAULT_NAME = "sandbox";

/** The default artifact when `--format` is omitted — the common case is "give me my sandbox as JSON". */
const DEFAULT_FORMAT = "json" as const;

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
    signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`sandbox export (multidoc) failed (${res.status} ${res.statusText}):\n${text}`);
  }
  return text;
}

/** Authed GET returning the parsed JSON body; throws on non-2xx with the body attached. */
async function getJson(url: string, auth: ResolvedAuth, label: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
    signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`sandbox export (${label}) failed (${res.status} ${res.statusText}):\n${text}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`sandbox export (${label}): could not parse the response as JSON:\n${text.slice(0, 200)}`);
  }
}

/**
 * Export the workspace currently deployed to the sandbox tenant as the JSON
 * bundle — the SAME `packageExport` shape `deploy` sends. Reads the deployed
 * tenant over the meta API (the mechanism `sidestep validate` uses), never the
 * local package:
 *   1. `sandbox/me` → the tenant (its base URL is the tenant-scoped meta origin).
 *   2. the tenant's `workspace` list → the sandbox's single workspace id.
 *   3. `workspace/{id}/export` → the gzipped archive, decoded to the bundle JSON.
 */
async function fetchSandboxWorkspaceJson(auth: ResolvedAuth): Promise<string> {
  const tenant = (await getJson(`${auth.instance}${SANDBOX_ME_PATH}`, auth, "sandbox/me")) as Record<string, unknown>;
  // The tenant is served under its own base (a `/tenant/<name>` path or its own
  // domain); APPEND routes to it so that path prefix survives.
  const base = sandboxBaseUrl(tenant, auth.instance);

  const list = (await getJson(`${base}/api:meta/workspace`, auth, "workspace list")) as unknown;
  const workspaces = Array.isArray(list) ? (list as Array<{ id?: unknown }>) : [];
  const workspaceId = workspaces.find((w) => typeof w.id === "number")?.id as number | undefined;
  if (workspaceId === undefined) {
    throw new Error(
      `Your sandbox has no workspace to export yet. Run \`sidestep sandbox deploy\` first, then export.`,
    );
  }

  const res = await fetch(`${base}/api:meta/workspace/${workspaceId}/export`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ branch: "", password: "" }),
    signal: AbortSignal.timeout(SANDBOX_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sandbox export (workspace export) failed (${res.status} ${res.statusText}):\n${text}`);
  }
  const bundle = decodeWorkspaceArchive(new Uint8Array(await res.arrayBuffer()));
  return JSON.stringify(bundle, null, 2);
}

/**
 * Produce the export content + its extension for the requested format. BOTH
 * formats export the deployed sandbox over OAuth and take NO local input.
 */
async function produce(args: ParsedArgs, format: "json" | "multidoc"): Promise<{ content: string; ext: "json" | "xs" }> {
  if (args.file !== undefined || args.bundle !== undefined) {
    throw new Error(
      `\`sandbox export\` takes no input — it exports the workspace CURRENTLY DEPLOYED to your ` +
        `sandbox (run \`sidestep sandbox deploy\` first). To compile a LOCAL workspace to JSON, use \`sidestep export <file>\`.`,
    );
  }
  const auth = await getAccessToken(args);
  return format === "json"
    ? { content: await fetchSandboxWorkspaceJson(auth), ext: "json" }
    : { content: await fetchSandboxMultidoc(auth), ext: "xs" };
}

export async function runSandboxExportCommand(args: ParsedArgs): Promise<void> {
  // `--format` is optional; JSON (the deployed workspace as a bundle) is the common case.
  const format = args.format ?? DEFAULT_FORMAT;

  const { content, ext } = await produce(args, format);
  const target = resolveOutputTarget({ path: args.path, name: args.name, ext });

  if (target.kind === "stdout") {
    // stdout is the data channel (like `export`): the raw artifact, nothing else.
    process.stdout.write(content + "\n");
    return;
  }

  writeFileSync(target.path, content + "\n", "utf8");
  // Progress goes to stderr so stdout stays a clean data channel even when writing a file.
  step(`Exported ${format} → ${target.path}`);
  success(`Wrote ${target.path}`);
}
