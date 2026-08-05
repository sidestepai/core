/**
 * `sidestep workspace <details|export|codegen>` — read the workspace your
 * credential is bound to.
 *
 * This is the *real* workspace, not a throwaway: the instance and workspace the
 * credential pins (at consent for `login`, or `workspace_id` for a hand-authored
 * meta API token). The family deliberately mirrors `sandbox`, since the two
 * answer the same three questions about different environments —
 *
 *   sidestep workspace details          which workspace am I actually bound to?
 *   sidestep workspace export           give me its bundle JSON
 *   sidestep workspace codegen <path>   give me its bundle as SideStep TypeScript
 *
 * — and deliberately stops there. **There is no `workspace deploy`.** The only
 * import path available is the server's clear-then-import, a full replace, so
 * writing back to a workspace holding real data is not something this CLI offers.
 * The loop is: pull from here, edit, deploy to an ephemeral or sandbox env.
 *
 * There is no workspace override: a credential addresses exactly one workspace.
 * Node-only (fetch/fs + OAuth); lazily imported by the command layer.
 */
import { writeFileSync } from "node:fs";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { resolveOutputTarget } from "./sandbox-export-command.js";
import { fetchWorkspaceBundle, runCodegenCommand } from "./codegen-command.js";
import { printMicroserviceSection, readMicroservices } from "./microservice-view.js";
import { formatFields, step, success, stdoutStyle } from "./ui.js";
import { removedSubcommand, unknownSubcommand } from "./errors.js";

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
      throw removedSubcommand("workspace", "deploy");
    default:
      throw unknownSubcommand("workspace", args.subcommand);
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
 * `workspace details` — which workspace the credential is bound to, and where.
 *
 * Worth its own verb because every other command in this family silently acts on
 * that pinned id; a user about to run `workspace codegen` should be able to check
 * what it will read before it reads it. It is also the only place a wrong
 * `workspace_id` in a hand-authored credential is diagnosed rather than 404ing.
 */
async function runDetails(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  const workspaceId = auth.workspaceId;
  const all = await fetchWorkspaces(auth);
  const match = all.find((w) => w.id === workspaceId);

  // A well-formed but WRONG `workspace_id` is the likeliest hand-authoring
  // mistake, and it is invisible everywhere else: other commands surface it as
  // an opaque 404 from the engine, and this one would otherwise print a
  // half-empty record that reads like a successful answer. Since this verb
  // exists to answer "what am I bound to", say plainly that the answer is
  // nothing — and list the ids that would work.
  if (!match) {
    const known = all
      .filter((w) => typeof w.id === "number")
      .map((w) => `  ${String(w.id).padStart(3)}  ${typeof w.name === "string" ? w.name : "(unnamed)"}`)
      .join("\n");
    const source =
      auth.credentialType === "token"
        ? `Fix \`workspace_id\` in your credential file`
        : `Run \`sidestep login\` again to re-pin it`;
    throw new Error(
      `Workspace ${workspaceId} does not exist on ${new URL(auth.instance).host} ` +
        `(or your credential cannot see it).\n${source}.` +
        (known === "" ? "" : `\n\nWorkspaces you can reach:\n${known}`),
    );
  }

  const summary = {
    instance: auth.instance,
    id: workspaceId,
    name: typeof match.name === "string" ? match.name : undefined,
    guid: typeof match.guid === "string" ? match.guid : undefined,
    /** Which credential this command is acting under — the only thing that selects a workspace. */
    credential: auth.credentialType,
  };

  // The real workspace is addressed at the instance origin under its OWN id —
  // never the fixed 1 an ephemeral/sandbox uses internally.
  const microservices = await readMicroservices(auth, auth.instance, workspaceId);

  if (!process.stdout.isTTY) {
    process.stdout.write(JSON.stringify({ ...summary, microservices }, null, 2) + "\n");
    return;
  }
  const s = stdoutStyle();
  const rows: Array<[string, string]> = [
    ["instance", summary.instance],
    ["workspace", `${summary.name ?? "(unnamed)"} ${s.dim(`#${summary.id}`)}`],
  ];
  if (summary.guid !== undefined) rows.push(["guid", summary.guid]);
  rows.push([
    "source",
    summary.credential === "token" ? "your meta API token credential" : "your sign-in (pinned at login)",
  ]);
  process.stdout.write(formatFields(rows) + "\n");
  printMicroserviceSection(microservices);
}

/**
 * `workspace export` — the workspace bundle as JSON.
 *
 * JSON only, unlike `sandbox export`: the multidoc route is a sandbox/tenant
 * surface, and the bundle is what `codegen` and `deploy` both speak.
 */
async function runExport(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  const bundle = await fetchWorkspaceBundle(auth);
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
