/**
 * `sidestep workspace <details|export|codegen>` — read the workspace your OAuth
 * token is scoped to.
 *
 * This is the *real* workspace, not a throwaway: the instance the token is bound
 * to, at the workspace id it consented to. The family deliberately mirrors
 * `sandbox`, since the two answer the same three questions about different
 * environments —
 *
 *   sidestep workspace details          which workspace am I actually scoped to?
 *   sidestep workspace export           give me its bundle JSON
 *   sidestep workspace codegen <path>   give me its bundle as SideStep TypeScript
 *
 * — and deliberately stops there. **There is no `workspace deploy`.** The only
 * import path available is the server's clear-then-import, a full replace, so
 * writing back to a workspace holding real data is not something this CLI offers.
 * The loop is: pull from here, edit, deploy to an ephemeral or sandbox env.
 *
 * `--workspace <id>` overrides the scoped id for an account with access to
 * several. Node-only (fetch/fs + OAuth); lazily imported by the command layer.
 */
import { writeFileSync } from "node:fs";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { resolveScopedWorkspaceId } from "../deploy/workspace.js";
import { resolveOutputTarget } from "./sandbox-export-command.js";
import { fetchWorkspaceBundle, runCodegenCommand } from "./codegen-command.js";
import { formatFields, step, success, stdoutStyle } from "./ui.js";

const TIMEOUT_MS = 30_000;

/** Default output basename for `workspace export` when `--name` is omitted. */
const DEFAULT_NAME = "workspace";

export async function runWorkspaceCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "details":
      return runDetails(args);
    case "export":
      return runExport(args);
    case "codegen":
      return runCodegenCommand(args, { kind: "workspace" });
    case "deploy":
      throw new Error(
        "`sidestep workspace deploy` does not exist — the only import path is a FULL REPLACE of the " +
          "target workspace, so SideStep never writes back to your real one. Use `sidestep deploy` " +
          "(`--dest ephemeral` by default, or `--dest sandbox`).",
      );
    default:
      throw new Error(
        `Unknown workspace subcommand "${args.subcommand ?? ""}". ` +
          "Expected `details`, `export`, or `codegen <path>`.",
      );
  }
}

/** The workspace list the account can see, from the meta API. */
async function fetchWorkspaces(auth: ResolvedAuth): Promise<Array<Record<string, unknown>>> {
  const url = new URL("/api:meta/workspace", auth.instance);
  const res = await fetch(url.href, {
    headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`workspace list failed (${res.status} ${res.statusText}):\n${text}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    throw new Error(`workspace list: could not parse the response as JSON:\n${text.slice(0, 200)}`);
  }
}

/**
 * `workspace details` — which workspace the token is scoped to, and where.
 *
 * Worth its own verb because every other command in this family silently acts on
 * that scoped id; a user about to run `workspace codegen` should be able to check
 * what it will read before it reads it.
 */
async function runDetails(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  const workspaceId = args.workspace ?? (await resolveScopedWorkspaceId(auth));
  const match = (await fetchWorkspaces(auth)).find((w) => w.id === workspaceId);

  const summary = {
    instance: auth.instance,
    id: workspaceId,
    name: typeof match?.name === "string" ? match.name : undefined,
    guid: typeof match?.guid === "string" ? match.guid : undefined,
    scoped: args.workspace === undefined,
  };

  if (!process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }
  const s = stdoutStyle();
  const rows: Array<[string, string]> = [
    ["instance", summary.instance],
    ["workspace", `${summary.name ?? "(unnamed)"} ${s.dim(`#${summary.id}`)}`],
  ];
  if (summary.guid !== undefined) rows.push(["guid", summary.guid]);
  rows.push(["source", summary.scoped ? "your token's scope" : "--workspace"]);
  process.stdout.write(formatFields(rows) + "\n");
}

/**
 * `workspace export` — the workspace bundle as JSON.
 *
 * JSON only, unlike `sandbox export`: the multidoc route is a sandbox/tenant
 * surface, and the bundle is what `codegen` and `deploy` both speak.
 */
async function runExport(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  const bundle = await fetchWorkspaceBundle(args, auth);
  const content = JSON.stringify(bundle, null, 2);

  const target = resolveOutputTarget({ path: args.path, name: args.name ?? DEFAULT_NAME, ext: "json" });
  if (target.kind === "stdout") {
    // stdout stays a clean data channel, as with every other export.
    process.stdout.write(content + "\n");
    return;
  }
  writeFileSync(target.path, content + "\n", "utf8");
  step(`Exported workspace → ${target.path}`);
  success(`Wrote ${target.path}`);
}
