/**
 * Agent-grounding manifest (DX follow-up). A machine-readable description of the
 * entire sidestep authoring surface — object kinds, statement catalog (with field
 * schemas for the declarative statements), value constructors, and tag catalog —
 * plus a human/LLM-readable `llms.txt` renderer.
 *
 * Everything here is DERIVED from the SDK's own sources of truth (the surface
 * catalog, the generated statement specs, the kind registry, the value/tag
 * primitives), so the manifest can never drift from what the SDK can actually
 * emit. Regenerate the committed `manifest.json` / `llms.txt` with
 * `npm run manifest`; the manifest test fails if they fall out of sync.
 */
// Side-effect imports: ensure every kind + statement is registered so the
// manifest's coverage reflects the full SDK regardless of how it's loaded.
import "../kinds/all.js";
import "../statements/s.js";
import { GENERATED_SPECS } from "../statements/generated/specs.generated.js";
import { SUPERSEDED_STATEMENTS } from "../statements/superseded.js";
import type { StatementSpec } from "../statements/schema-dsl/interpret.js";
import {
  STATEMENT_SURFACES,
  TOTAL_STATEMENTS,
  sPathOf,
} from "../statements/surfaces.js";
import { isRegisteredStatement } from "../statements/statement.js";
import { isRegisteredKind } from "../kinds/kind.js";
import { TAGS } from "../types/xdo.js";
import { FILTER_NAMES, FILTER_SPECS } from "../values/generated/filters.generated.js";
import { FIELD_METHODS } from "../fields/generated/field-methods.generated.js";

/** Total engine object kinds. */
export const TOTAL_OBJECT_KINDS = 30;

/** A statement field, flattened from its generated spec rule. */
export interface ManifestField {
  name: string;
  /** `string` (a plain string arg), `value` (a tagged `Value`), or `comparison`. */
  type: StatementSpec["rules"][number]["type"];
  optional: boolean;
  default?: string;
}

/** One statement authoring surface. */
export interface ManifestStatement {
  /** Canonical surface key (the engine schema basename), e.g. `array.filter`. */
  surface: string;
  /** Stored `mvp:` name emitted into the bundle. */
  storedName: string;
  /** Dotted accessor under `s`, e.g. `array.filter` → `s.array.filter`. */
  sPath: string;
  /** Whether the stored name has a registered factory (authorable today). */
  registered: boolean;
  /** True when generated from the engine schema (carries a field schema). */
  declarative: boolean;
  /** Whether the statement emits an `output` envelope. Declarative only. */
  output?: boolean;
  /**
   * What the statement's `as:` output variable holds — so the manifest answers
   * "what does this bind?" without falling back to prose. Curated (see
   * `STATEMENT_RESULTS`); present only for statements whose result is stable and
   * documented. Analogous to {@link ManifestFilter.result}, but structured: `name`
   * is the binding field (always `as` today, carried explicitly so the descriptor
   * is self-describing for machine consumers), `type` its value type, `note` an
   * optional caveat.
   */
  result?: { name: string; type: string; note?: string };
  /** Field schema — present for declarative statements. */
  fields?: ManifestField[];
  /**
   * An older paradigm the SDK still SUPPORTS but no longer wants authored — same
   * contract as {@link ManifestValue.legacy}: withheld from the per-namespace
   * catalog an agent picks from, and named-only in the `## Legacy` index.
   */
  legacy?: boolean;
}

/**
 * One authoring factory within a kind that fans out into several distinct
 * root factories sharing a single encoder/payload key — today only `trigger`
 * (six `obj_type`s, one shared stored envelope). Each sub-kind is a first-class
 * root factory in its own right; the manifest lists them individually so agents
 * treat them like every other primitive.
 */
export interface ManifestSubKind {
  /** Root authoring factory export, e.g. `tableTrigger`. */
  authorFactory: string;
  /** The stored `obj_type` this factory produces, e.g. `database`. */
  objType: string;
  /** Rich "what this primitive does" descriptor, in the style of a top-level kind. */
  description: string;
  /** Built and registered, but withheld from the published catalog — see {@link ManifestKind.unpublished}. */
  unpublished?: boolean;
  /**
   * An older paradigm the SDK still SUPPORTS but no longer wants authored — same
   * contract as {@link ManifestValue.legacy}: withheld from the sub-kind catalog
   * and the trigger prose, and named-only in the `## Legacy` index.
   *
   * Distinct from `unpublished`, which withholds a factory that is not ready.
   * A legacy factory is fully ready and fully supported; it is the *paradigm*
   * that has been superseded.
   */
  legacy?: boolean;
}

/** One top-level object kind. */
export interface ManifestKind {
  /** Stable kind name, e.g. `function`. */
  kind: string;
  /** `packageExport` payload key, e.g. `function`, `dbo`. */
  payloadKey: string;
  /** Authoring factory export, e.g. `defineFunction`, `table`. */
  authorFactory: string;
  /** One-line "what this primitive does" descriptor, surfaced in `llms.txt`. */
  description: string;
  /** `Xano` registration method, e.g. `registerFunctions`. */
  registerMethod: string;
  /** Whether the kind has a registered encoder (implemented today). */
  registered: boolean;
  /**
   * Distinct root factories that all persist under this kind's encoder/payload
   * key. When present, the `## Object kinds` catalog lists each sub-kind as its
   * own root-level entry instead of the grouped `authorFactory` line. Only
   * `trigger` uses this today.
   */
  subKinds?: ManifestSubKind[];
  /**
   * Built and registered, but deliberately withheld from the published agent
   * surface — kept out of the emitted manifest, out of `llms.txt`, and out of
   * the coverage numerator.
   *
   * This is a *release* gate, not a completeness gate. The kind still has a
   * descriptor here so the "descriptors match the live kind registry" drift
   * guard keeps covering it; it just does not ship in the catalog yet. Flip the
   * flag off to publish — nothing else needs to change.
   */
  unpublished?: boolean;
}

/** A value constructor / helper. */
export interface ManifestValue {
  name: string;
  signature: string;
  description: string;
  /**
   * An older paradigm the SDK still SUPPORTS but no longer wants authored.
   *
   * Kept out of the `## Values` catalog — the list an agent picks from when it
   * builds — and named-only in the `## Legacy` index at the end of `llms.txt`.
   * That split is the whole point: hiding it entirely is worse than useless,
   * because a pulled workspace can legitimately contain one, and an agent that
   * has never heard of it will "fix" what it does not recognize. Naming it
   * without a signature says "you will see this; do not reach for it."
   */
  legacy?: boolean;
}

/** One value-pipeline filter (`fl.<name>`). */
export interface ManifestFilter {
  /** Filter name, as stored in the value `filters[]` chain. */
  name: string;
  /** Dotted accessor: `fl.<name>`. */
  fl: string;
  /** Whether it carries named, typed args (vs. variadic-by-name). */
  typed: boolean;
  /** Named, typed args (richly-specified filters only). */
  args?: Array<{ name: string; type: string; optional?: boolean }>;
  /** Result type (richly-specified filters only). */
  result?: string;
  /** Group, e.g. `timestamp`, `vector` (richly-specified filters only). */
  group?: string;
  /** One-line description, when known. */
  description?: string;
}

/** One field-catalog type (`f.<name>` / `input.<name>`). */
export interface ManifestFieldType {
  /** Authoring constructor name under `f` / `input`, e.g. `text`, `tableRef`. */
  name: string;
  /** The stored type string emitted into the schema, e.g. `epochms`, `blob_img`. */
  stored: string;
  /** Valid bind-method names for this type (empty = none; `{name,arg}` escape hatch only). */
  methods: string[];
  /** Present and true when the type exists under `input.` only, with no `f.` column form. */
  inputOnly?: boolean;
}

/** One CLI flag, with the effect it has. */
export interface ManifestCliFlag {
  flag: string;
  description: string;
}

/**
 * One CLI command. Hand-maintained (there is no SDK source of truth for CLI
 * verbs), so — unlike the derived catalogs — this is the one manifest section
 * kept in sync by editing `CLI_COMMANDS` below when the CLI surface changes.
 */
export interface ManifestCliCommand {
  /** The invocation verb, e.g. `deploy`. */
  command: string;
  /** Positional argument grammar, when the command takes one. */
  args?: string;
  flags?: ManifestCliFlag[];
  description: string;
}

export interface Manifest {
  name: string;
  version: string;
  description: string;
  coverage: {
    objectKinds: { implemented: number; total: number };
    statements: { implemented: number; total: number };
    filters: { typed: number; total: number };
  };
  values: {
    constructors: ManifestValue[];
    tags: readonly string[];
  };
  objectKinds: ManifestKind[];
  fieldTypes: ManifestFieldType[];
  statements: ManifestStatement[];
  filters: ManifestFilter[];
  /** The CLI command surface (compile/export/deploy/auth/lock). Hand-maintained. */
  cli: ManifestCliCommand[];
}

/**
 * The CLI command surface, structured for programmatic agents that read
 * `manifest.json` directly (the prose walkthrough lives in `llms.txt`). There is
 * no SDK source of truth for CLI verbs, so this list is hand-maintained: keep it
 * in sync with `USAGE` / the dispatch in `src/emit/cli.ts` when commands change.
 */
const CLI_COMMANDS: readonly ManifestCliCommand[] = [
  {
    command: "compile",
    args: "<file> [--out <path>]",
    description: "Emit one function's importable JSON to --out (or stdout).",
  },
  {
    command: "export",
    args: "<file> [--out <path>]",
    flags: [
      { flag: "--lock[=<path>]", description: "Freeze object guids into a committed xano.lock (default: beside the entry)." },
      { flag: "--frozen-lock", description: "CI guard: fail instead of changing the lock." },
    ],
    description: "Compile the default-exported Xano registry into the aggregate workspace bundle.",
  },
  {
    command: "paths",
    args: "<file> [--lock=<path>]",
    description:
      "List every API query's HTTP verb and resolved group-relative path (api:<canonical>/<name>). Alias: `routes`. Read-only — seeds an existing xano.lock to resolve canonicals but never writes one; a group with no resolvable canonical is reported with the `export --lock` fix.",
  },
  {
    command: "deploy",
    args: "<file> | --bundle <path>",
    flags: [
      { flag: "--dest <sandbox|ephemeral>", description: "Which environment to import into. Default `ephemeral`: a named, workspace-scoped, auto-expiring tenant, create-or-refreshed (tracked in ./.xano/ephemeral.json). `sandbox`: the throwaway singleton. Both do a FULL REPLACE (reset is inherent; no opt-out)." },
      { flag: "--name <display>", description: "Ephemeral display name at create time (default: the workspace name from the bundle, else the project dir basename). Ignored for --dest sandbox." },
      { flag: "--expires-hours <n>", description: "Ephemeral TTL at create time, 1–72 (default 1). Only applies when a new ephemeral is created, not on refresh." },
      { flag: "--static <dir>", description: "Archive a built frontend directory and deploy it to a static host after the backend import. The target follows --dest: `ephemeral` puts it on the EPHEMERAL itself, `sandbox` on your OWN (parent) workspace (the sandbox tenant does not serve static hosting). The deployed env's backend URL is auto-injected into the build's root index.html as `window.XANO_HOST`, so the frontend needs no rebuild." },
      { flag: "--static-host <name>", description: "Static-host NAME to deploy the frontend to (default `default`). Give each app a DISTINCT host so deploys don't share and overwrite the one `default` host. The host is auto-created on first deploy." },
      { flag: "--static-env KEY=VALUE", description: "Repeatable. Bake extra PUBLIC config into the static build's index.html as `window.<KEY>` globals. Merged over the auto-seeded XANO_HOST; served verbatim, so never put secrets here." },
      { flag: "--no-verify", description: "Skip the post-deploy liveness poll. By default, after a --static upload the CLI polls the deployed URL until the edge is serving THIS build (matching its X-Xano-Canonical), so success means the frontend is actually live — not just that the build was accepted. An unconfirmed poll is a warning, never a failure. Use --no-verify for fast iterative deploys or when the URL isn't reachable from the CLI host." },
      { flag: "--config <path>", description: "Explicit credential file path (default: $XANO_CONFIG, then the shared ~/.sidestep/auth.json, falling back to ./.xano/auth.json when it exists). Either credential type is accepted." },
      { flag: "--local", description: "Read credentials from the project-local ./.xano/auth.json cache instead of the shared ~/.sidestep/auth.json one. Reads already prefer an existing project-local cache, so this only matters when both exist." },
    ],
    description:
      "Deploy the compiled workspace to a live environment and print its URL. Default `--dest ephemeral` create-or-refreshes a named auto-expiring environment: a live one is refreshed (URL unchanged), a gone/expired one is recreated (the new URL is called out). `--dest sandbox` targets the singleton throwaway. Each deploy is a full replace. Prints a projected, secret-free summary as JSON on stdout when piped. Never writes SERVER identities back into xano.lock (the compile step still maintains it as `export` does).",
  },
  {
    command: "release",
    args: "<file> | --bundle <path>",
    flags: [
      { flag: "--yes", description: "Skip the replace-confirmation (for CI). Only relevant once release is enabled." },
    ],
    description:
      "COMING SOON. Promotes your compiled workspace to your MAIN Xano instance workspace (the production target), vs. `deploy` which ships to a disposable ephemeral/sandbox. The target workspace is the one your OAuth token is scoped to — there is no override. Currently gated: it prints a 'coming soon' message and takes no action, pending a record-preserving import (a release must not wipe production table data the way a full replace would).",
  },
  {
    command: "ephemeral list|get|delete|export|impersonate",
    args: "[<name>] [--all-workspaces] [--format <json|multidoc>] [--path <path>|-] [--guest] [--url-only] [--yes]",
    flags: [
      { flag: "list [--all-workspaces]", description: "List ephemeral tenants in your credential's workspace, or across every workspace on the instance with --all-workspaces. Expired-but-unswept rows are marked." },
      { flag: "get <name>", description: "Show one ephemeral's base URL, state, and expiry (JSON when piped)." },
      { flag: "delete <name> [--yes]", description: "Destroy an ephemeral (confirm unless --yes/--force). Idempotent if already gone; clears the matching local record." },
      { flag: "export <name> [--format json|multidoc] [--path <p>|-]", description: "Export the ephemeral's workspace as the JSON bundle (default) or XanoScript multidoc (.xs), mirroring `sandbox export`." },
      { flag: "codegen <name> <path>", description: "Pull the ephemeral's workspace into a runnable SideStep project at <path>. Note the positional order: tenant first, output path second." },
      { flag: "impersonate <name> [--guest] [--url-only]", description: "Mint a one-time token and open the ephemeral in the builder. --guest = read-only session. --url-only prints the dashboard URL instead of opening a browser; when piped, output is JSON ({ _ti, url })." },
    ],
    description:
      "Manage the ephemeral environments `deploy` creates. get/export/delete resolve the tenant first: a swept (404) or past-expiry tenant yields one actionable 'run `sidestep deploy`' message (never touching the dead env), and clears its stale local record.",
  },
  {
    command: "sandbox export",
    args: "[--format <json|multidoc>] [--path <path>|-] [--name <name>]",
    flags: [
      { flag: "--format json", description: "(default) Export the workspace CURRENTLY DEPLOYED to your sandbox as the JSON bundle — the same packageExport shape `deploy` sends — and write a .json file. Reads the deployed tenant over the meta API (sandbox/me → the tenant's workspace export → decode), NOT the local package." },
      { flag: "--format multidoc", description: "GET the sandbox tenant's XanoScript multidoc over OAuth and write it to a .xs file." },
      { flag: "--path <path>|-", description: "Output location: a directory (writes <name>.<ext> inside it), a full file path (verbatim), or `-` for stdout. Default: ./sandbox.<ext> in the cwd." },
      { flag: "--name <name>", description: "Output basename override (default `sandbox`)." },
    ],
    description:
      "Export the workspace CURRENTLY DEPLOYED to your sandbox — as the JSON bundle (default) or the XanoScript multidoc (.xs). Both are pure OAuth meta calls against the sandbox: no local file, no compile step, so a bare `sandbox export` just works (run `sidestep deploy --dest sandbox` first). To compile a LOCAL workspace to JSON instead, use `sidestep export <file>`. env/records/draft are unsupported (endpoint defaults).",
  },
  {
    command: "workspace details|export|codegen",
    args: "[<path>] [--path <path>|-] [--name <name>] [--ai <preset>] [--force] [--no-install] [--no-verify]",
    flags: [
      { flag: "details", description: "Show which workspace your credential is bound to — instance, numeric id, name, guid, and which credential selected it. Read it before `export`/`codegen` to confirm what they will read." },
      { flag: "export [--path <p>|-] [--name <n>]", description: "Write the workspace bundle JSON (the same packageExport shape `deploy` sends). JSON only — the multidoc route is a sandbox/tenant surface." },
      { flag: "codegen <path>", description: "Decode the workspace into a runnable SideStep project at <path> (the `init` scaffold with `xano/` filled from the pull), then verify it re-exports identically." },
    ],
    description:
      "Read the REAL workspace your credential is bound to, via `workspace/{id}/export` (the compressed bundle). The workspace id comes from the credential and cannot be overridden. Deliberately read-only: there is no `workspace deploy`, because the only import path is a FULL REPLACE of the target workspace. The loop is pull from here, edit, then `deploy` to a disposable ephemeral/sandbox env.",
  },
  {
    command: "codegen",
    args: "<bundle.json> <path> [--name <n>] [--ai <preset>] [--force] [--no-install] [--no-verify]",
    flags: [
      { flag: "<bundle.json>", description: "A bundle already on disk (from `sidestep export` or any `<env> export`). Pure and OFFLINE — no auth, no network." },
      { flag: "<path>", description: "Project directory. Created if absent. A directory a previous codegen wrote (it carries `xano/.sidestep-codegen.json`) has its `xano/` refreshed in place; any other non-empty directory is refused unless --force." },
      { flag: "--name <n>", description: "Package name for the scaffolded project (default: the target directory basename)." },
      { flag: "--ai <preset>", description: "Scaffold AI-assistant instructions (claude|codex|cursor|none, repeatable). The codegen variant tells an agent that `xano/` is machine-written and regenerated wholesale." },
      { flag: "--force", description: "Write into a non-empty directory that is not a previous codegen project. `xano/` is cleared first so files from an earlier tree cannot survive as orphans." },
      { flag: "--no-install", description: "Skip the post-scaffold `npm install`. Verification needs the dependencies to load the tree, so this also leaves the round trip unchecked." },
      { flag: "--no-verify", description: "Skip the post-write round-trip check. On by default; skipping it leaves the tree unchecked." },
    ],
    description:
      "Decode a Xano bundle into a RUNNABLE project: the same scaffold `sidestep init` writes (root package.json with dev/build/xano:export/xano:deploy, tsconfig, vite config, frontend/) with the decoded workspace filling `xano/` — one directory per kind with each object under its parent (`query/<group>.ts` beside `query/<group>/<name>_<VERB>.ts`, `table/trigger/`, `agent/trigger/`, and realtime's three levels as `realtime_server/<server>.ts` beside `realtime_server/<server>/<channel>.ts` beside `.../<channel>/<message>.ts`, with a `trigger/` at each level). Anything holding children is a file named for ITSELF sitting beside their folder, so no two tabs read alike and a childless container needs no folder. Every table has its own file under `table/`, settings in `xano/workspace.ts`, a `_shared.ts` for anything else referenced from more than one file, a barrel `xano/index.ts`, and `xano/README.md` carrying the decode report. Paths are LOWER CASE throughout (the HTTP verb is the one exception), while bindings keep the object's own casing — so a file name and the symbol it exports can differ. So `sidestep <src> codegen app && cd app && npm run build && npm run xano:deploy` ships a pulled workspace to a live ephemeral URL. Guids are preserved verbatim so references stay consistent. A statement the catalog cannot model round-trips verbatim through `raw()` from `@sidestep/core/codegen`. After install, the tree is loaded, re-exported, and diffed against the source bundle — a mismatch names the object and FAILS. `xano/` is disposable and schema-only (no seed rows): re-running rewrites it (the rest of the project is left alone) and deploying is a full replace, so send it only to an ephemeral/sandbox env. Workspace env var VALUES are carried inline in `xano/workspace.ts`, so treat a pulled tree as secret-bearing. The live variants are `workspace codegen`, `sandbox codegen`, and `ephemeral codegen`.",
  },
  {
    command: "sandbox codegen",
    args: "<path> [--name <n>] [--ai <preset>] [--force] [--no-install] [--no-verify]",
    description:
      "Pull the workspace CURRENTLY DEPLOYED to your sandbox into a runnable SideStep project at <path>. Same core as `sidestep codegen <bundle.json>`; only the source differs. See `codegen` for the flags and the disposable/full-replace boundaries.",
  },
  {
    command: "sandbox details",
    args: "[--config <path>] [--local]",
    description:
      "Print the sandbox tenant as JSON, headlined by its public `baseUrl` — read it to point a frontend at the deployed backend without re-running a deploy. Projects only safe fields (never the raw tenant blob).",
  },
  {
    command: "profile me",
    args: "[--config <path>] [--local]",
    description:
      "Print the scoped user and the instance base URL as JSON — read `instance` to configure a frontend's API base before a --static upload.",
  },
  {
    command: "login",
    args: "[--origin <origin>] [--config <path>] [--local] [--port <n>] [--scope <list>]",
    description: "OAuth sign-in (browser consent; pick the instance AND workspace at consent). Writes a `type: \"oauth\"` credential to the shared ~/.sidestep/auth.json (reused from any project), or the project-local ./.xano/auth.json with --local, PINNING the numeric workspace so no later command looks it up or overrides it. For CI, set $XANO_REFRESH_TOKEN + $XANO_CLIENT_ID instead.",
  },
  {
    command: "logout",
    args: "[--config <path>] [--local]",
    description: "Delete the stored credential — the shared ~/.sidestep one by default, or the project-local ./.xano one with --local. An `oauth` credential is revoked at the authorization server first; a hand-authored `token` credential has nothing to revoke, so the file is simply removed.",
  },
  {
    command: "lock",
    args: "<rename|prune|adopt> …",
    description: "xano.lock identity maintenance (rename an object, prune stale entries, adopt an existing live bundle).",
  },
  {
    command: "completion",
    args: "<bash|zsh|fish>",
    description:
      "Print a shell completion script to stdout, generated from the CLI's own command table — every " +
      "command, verb, flag, and closed value set (`--dest`, `--format`, `--ai`). Baked at generation " +
      "time, so re-run it after upgrading. Install: `sidestep completion zsh > \"${fpath[1]}/_sidestep\"`, " +
      "`sidestep completion bash > ~/.sidestep-completion.bash` (then source it), or " +
      "`sidestep completion fish > ~/.config/fish/completions/sidestep.fish`.",
  },
  {
    command: "version",
    args: "",
    description: "Print the installed @sidestep/core version to stdout (also `--version` / `-v`). Handy for debugging which build is running.",
  },
  {
    command: "help",
    args: "",
    description:
      "Print the grouped command reference to stdout (also the no-argument default, `--help`, and `-h`). " +
      "`--help`/`-h` also works AFTER a command or verb — `sidestep deploy --help`, `sidestep workspace codegen --help` " +
      "— printing that scope's usage, subcommands, and accepted flags. Requested help goes to stdout and exits 0; " +
      "a usage failure (unknown command or verb, missing argument) prints the same block to STDERR under a `✗` line, " +
      "with a did-you-mean when one is close, and exits nonzero.",
  },
];

/**
 * The 12 implemented object kinds with their authoring + registration metadata.
 * `registered` is verified against the live kind registry at build time, and the
 * manifest test asserts payload keys match `registeredKinds()`. `mcp_server` and
 * `agent` are distinct kinds that both persist under the `toolset` payload key.
 */
export const KIND_DESCRIPTORS: ReadonlyArray<Omit<ManifestKind, "registered">> = [
  { kind: "function", payloadKey: "function", authorFactory: "defineFunction", description: "Reusable server-side logic (a custom function) callable from any stack via `s.function.run`.", registerMethod: "registerFunctions" },
  { kind: "table", payloadKey: "dbo", authorFactory: "table", description: "A database table: typed columns (`f.*`), indexes, and views; the schema other kinds read and write.", registerMethod: "registerTables" },
  { kind: "query", payloadKey: "query", authorFactory: "query", description: "An HTTP API endpoint (verb + path) bound to an API group; the main request/response surface.", registerMethod: "registerQueries" },
  { kind: "api_group", payloadKey: "app", authorFactory: "apiGroup", description: "A container that groups queries under a shared base path, CORS, and swagger config.", registerMethod: "registerApiGroups" },
  {
    kind: "trigger",
    payloadKey: "trigger",
    authorFactory: "{tableTrigger,realtimeServerTrigger,realtimeChannelTrigger,mcpServerTrigger,agentTrigger,workspaceTrigger,errorTrigger}",
    description: "An event-driven handler fired by a DB write, a realtime server connection or channel join/leave/deliver, an MCP/agent connection, a branch lifecycle event, or an error — inputs are implied by type and arrive on the `t` handle.",
    registerMethod: "registerTriggers",
    subKinds: [
      { authorFactory: "tableTrigger", objType: "database", description: "Fires when rows change on a bound table (insert/update/delete/truncate). The changed row is exposed as `t.new`/`t.old`, typed to the table when a `table()` handle is bound. Config-only (no response). `search` filters rows in the DATABASE, so it uses `col(\"NEW.x\")`/`col(\"OLD.x\")`, not `t`; invalid with `truncate`, and insert/delete cannot read the absent side." },
      { authorFactory: "realtimeTrigger", objType: "workspace_realtime_channel", legacy: true, description: "the SUPERSEDED realtime trigger, against the workspace-global realtime layer — a different object from the current `channel`, despite the similar name. For a join hook use `realtimeChannelTrigger({ actions: { join: true } })`; for message handling use a `realtimeMessage()` handler, which is the current equivalent of its `message` action (a message is an authored unit now, not a trigger action)." },
      { authorFactory: "realtimeServerTrigger", objType: "realtime_server", description: "Fires when a client connects to or disconnects from a realtime server; inspect the connecting client and its permissions via `t`. Bind with `realtimeServer`. Response-bearing." },
      { authorFactory: "realtimeChannelTrigger", objType: "channel", description: "Fires when a client joins or leaves a channel; inspect the addressed channel path and the client via `t`. Bind with a `realtimeChannel()` handle (a bare path is ambiguous across servers). Response-bearing." },
      { authorFactory: "mcpServerTrigger", objType: "toolset", description: "Fires when an MCP client connects to a bound MCP server; gate or annotate the exposed tools via `t.toolset`/`t.tools`. Response-bearing." },
      { authorFactory: "agentTrigger", objType: "toolset", description: "Fires when a client connects to a bound agent; gate or annotate its toolset via `t.toolset`/`t.tools`. Response-bearing." },
      { authorFactory: "workspaceTrigger", objType: "workspace", description: "Fires on branch lifecycle events (branch new/merge/live); inspect the from/to branch and action via `t`. Config-only." },
      { authorFactory: "errorTrigger", objType: "error", description: "Fires when an error signature is first seen, regresses, or is marked fixed; inspect the error, caller, statement, and occurrence counts via `t`. Config-only." },
    ],
  },
  { kind: "tool", payloadKey: "tool", authorFactory: "tool", description: "An agent/MCP tool: a callable capability with typed inputs an AI agent can invoke.", registerMethod: "registerTools" },
  { kind: "mcp_server", payloadKey: "toolset", authorFactory: "mcpServer", description: "An MCP server exposing a set of tools to external MCP clients.", registerMethod: "registerMcpServers" },
  { kind: "agent", payloadKey: "toolset", authorFactory: "agent", description: "An AI agent: an LLM configuration plus the tools it can call. Invoke it from any stack (query/function/task/tool/trigger) with `s.ai.agent.run` — no public endpoint; the result is a rich envelope whose completion text is at `.result`.", registerMethod: "registerAgents" },
  { kind: "task", payloadKey: "task", authorFactory: "task", description: "A scheduled background job (cron/interval) that runs a stack on a timer.", registerMethod: "registerTasks" },
  { kind: "middleware", payloadKey: "middleware", authorFactory: "middleware", description: "A reusable pre/post stack attached to a query/function/task/tool/API group to run before or after its own logic.", registerMethod: "registerMiddleware" },
  { kind: "addon", payloadKey: "addon", authorFactory: "addon", description: "A reusable read fragment that enriches a query result by joining related table data.", registerMethod: "registerAddons" },
  { kind: "realtime_server", payloadKey: "realtime_server", authorFactory: "realtimeServer", description: "A realtime (websocket) server: the canonical-addressed container that owns realtime channels. Off until `enabled: true`. Returns a handle with `getUrl(baseUrl)`/`getPath()` for the client's socket URL (`wss://<host>/ws/<canonical>`).", registerMethod: "registerRealtimeServers" },
  { kind: "channel", payloadKey: "channel", authorFactory: "realtimeChannel", description: "A realtime channel: a joinable path on a realtime server (`rooms/{room_id}`) with typed path params, join/publish policy, a client-visible conversation transcript, and delivery semantics. Owns message handlers. Returns a handle with `getChannel(params)` for the path a client joins.", registerMethod: "registerRealtimeChannels" },
  { kind: "message", payloadKey: "message", authorFactory: "realtimeMessage", description: "A realtime message handler: a named message type on a channel with its own typed payload and stack — the realtime analogue of a query. Pass the `realtimeChannel()` handle as `channel` and the owning server comes with it.", registerMethod: "registerRealtimeMessages" },
  { kind: "microservice", payloadKey: "microservice", authorFactory: "microservice", description: "A container workload deployed alongside the workspace, called from a stack with `s.api.microservice`. Two mutually exclusive shapes via `kind`: `builtin` declares containers (image/ports/resources/env/command/args) plus optional `ingresses`, and `helm` points at a chart and its `values` — passing both throws. EARLY SURFACE, expected to change: `configs`/`volumes` are typed but unconfirmed against a live engine. SECRETS RIDE ALONG — `chart.values` and `registryAuth.dockerconfigjson` are carried into a pulled tree verbatim (they must be, or a pulled microservice could not be redeployed), so a tree holding a private-registry microservice holds a live credential; prefer leaving `dockerconfigjson` unset and supplying it out of band.", registerMethod: "registerMicroservices" },
  { kind: "workspace", payloadKey: "workspace", authorFactory: "workspaceConfig", description: "Workspace-level configuration such as default middleware chains and request-history defaults per host kind.", registerMethod: "registerWorkspace" },
];

/** Value constructors / helpers exported from the package root. */
const VALUE_CONSTRUCTORS: ReadonlyArray<ManifestValue> = [
  { name: "c.text", signature: "(s: string) => Value", description: 'String constant → tag "const".' },
  { name: "c.int", signature: "(n: number) => Value", description: 'Integer constant → tag "const:int".' },
  { name: "c.decimal", signature: "(n: number | string) => Value", description: 'Decimal constant → tag "const:decimal". Pass a string only to keep a stored spelling a number cannot reproduce (c.decimal("10.00") keeps its trailing zeros).' },
  { name: "c.blank", signature: '(tag: "const:<type>") => Value', description: 'The editor\'s UNCONFIGURED value box (stored value ""), emitted by codegen for a pulled workspace — do not author it. NOT a zero or an empty collection: the engine reads "" and "0" differently, so c.blank("const:int") ≠ c.int(0) and neither canonicalizes into the other. Constant tags except const/const:obj, whose blanks are c.text("")/c.obj(null).' },
  { name: "c.bool", signature: "(b: boolean) => Value", description: 'Boolean constant → tag "const:bool".' },
  { name: "c.null", signature: "() => Value", description: 'Null constant → tag "const:null".' },
  { name: "c.obj", signature: "(o?: Json | null) => Value", description: 'Object constant (JSON string) → tag "const:obj". No argument = the empty object {} — use this one. Explicit null = the legacy blank form the engine evaluates to null, NOT {}; it exists only so a pulled workspace round-trips, do not author it. Plain JSON literals only — a nested tagged value (inp/ref/auth/c.*) is rejected; for a computed object response use a record of values, not c.obj.' },
  { name: "c.array", signature: "(a: Json[]) => Value", description: 'Array constant (JSON string) → tag "const:array". Plain JSON literals only — a nested tagged value is rejected, same as c.obj.' },
  { name: "c.expression", signature: "(source: string) => Value", description: 'Xano Expression Engine source, passed through VERBATIM → tag "const:expr2". The string IS the expression: c.expression(\'"Hi, " ~ $input.name\'), c.expression("$var.price * $var.qty"). ⚠️ NOT VALIDATED — never parsed or type-checked, invisible to InferResponse, and untouched by a rename that updates every typed ref(); a typo surfaces at runtime or as a wrong answer. Use it ONLY for syntax the typed surfaces cannot express (~ concatenation, inline arithmetic, conditionals) — prefer ref/inp/col, withFilters+fl.*, and obj() (which BUILDS a checked expression). Not the expr() condition builder.' },
  { name: "c.expressionLegacy", signature: "(source: string) => Value", legacy: true, description: 'the older `const:expr` expression form, emitted by codegen for workspaces that still hold one — author `c.expression` instead.' },
  { name: "c.now", signature: "() => Value", description: 'Current time as epoch-ms — the engine-native const:epochms constant (no filter). Valid inline as a where/cmp operand. For cutoff math (cutoff = now - max_age) either compare inline or, for reuse/readability, hoist it into an s.set_var and compare against the var.' },
  { name: "obj", signature: "(fields: Record<string, Value | nested>) => Value", description: 'Dynamic object value → tag "const:expr2" (a XanoScript object-literal expression). The dynamic sibling of c.obj: members may be inp/ref/auth/col/c.* values, nested records, or arrays. A value with filters, or a less-common tag (env/setting/output/…), is rejected. Use for e.g. s.ai.agent.run args.' },
  { name: "ref", signature: "(name: string, opts?: { safe?: boolean }) => Value", description: 'Reference a stack variable → tag "var". Pass { safe: true } for null-safe nested access — a dotted ref("owner.user_id", { safe: true }) compiles through the get filter so it resolves to null instead of raising "Unable to locate var" when the base is null.' },
  { name: "inp", signature: "(name: string) => Value", description: 'Reference a function input → tag "input".' },
  { name: "col", signature: "(name: string) => Value", description: 'Reference a table column → tag "col".' },
  { name: "auth", signature: "(path?: string) => Value", description: 'Reference the authenticated identity (auth("id") → $auth.id) → tag "auth".' },
  { name: "caught", signature: '(path?: "code" | "message" | "name" | "result") => Value', description: 'Read the caught error inside an s.try_catch CATCH arm → tag "trycatch". Valid ONLY there — it reads empty in the try/finally arms and outside the statement. Those four fields are all the engine binds (result is the attached payload); bare caught() is the whole error record.' },
  { name: "env", signature: "(name: string) => Value", description: 'Read a WORKSPACE environment variable (set via workspaceConfig({ env }) or the dashboard) → `$env.NAME`. Compiles to tag "setting" with the plain name. env("remote_ip") reads a user var named remote_ip, not the caller IP — use sys.remoteIp() for that.' },
  { name: "setting", signature: "(name: string) => Value", description: 'Reference a workspace setting → tag "setting". Built-in system vars are $-prefixed settings, e.g. setting("$remote_ip"); prefer the typed sys.* accessors.' },
  { name: "sys.*", signature: "() => Value", description: 'Built-in system / request-context variables → tag "setting" ($-prefixed). Accessors: remoteIp, requestMethod, requestUri, requestQueryString, httpHeaders, requestAuthToken, apiBaseUrl, datasource, branch, tenant, release, platform, isDebugger. In XanoScript these are $env.$remote_ip etc.; sys.remoteIp() is the public-endpoint rate-limit key (auth("id") is null there).' },
  { name: "filter", signature: "(name: string, ...args: Value[]) => FilterXdo", description: "Build a filter-chain entry by raw name (escape hatch)." },
  { name: "fl.*", signature: "(...args: Value[]) => FilterXdo", description: "Typed value-pipeline filters; see the `filters` catalog." },
  { name: "withFilters", signature: "(value: Value, ...filters: FilterXdo[]) => Value", description: "Attach a filter chain to a value (filters passed spread; an array is also accepted)." },
];

/**
 * The field catalog (`f.*` / `input.*`): authoring name → stored type, plus the
 * `FIELD_METHODS` key when its valid methods live under a different key (e.g.
 * `tableRef`). Methods are joined in from the generated per-type sets so the
 * manifest can never disagree with what the constructors accept.
 */
const FIELD_DESCRIPTORS: ReadonlyArray<{
  name: string;
  stored: string;
  methodKey?: string;
  inputOnly?: boolean;
}> = [
  { name: "text", stored: "text" },
  { name: "int", stored: "int" },
  { name: "decimal", stored: "decimal" },
  { name: "bool", stored: "bool" },
  { name: "uuid", stored: "uuid" },
  { name: "date", stored: "date" },
  { name: "email", stored: "email" },
  { name: "password", stored: "password" },
  { name: "json", stored: "json" },
  { name: "timestamp", stored: "epochms" },
  { name: "image", stored: "blob_img" },
  { name: "video", stored: "blob_video" },
  { name: "audio", stored: "blob_audio" },
  { name: "attachment", stored: "blob" },
  // Input-only: a raw upload is the request's bytes, not something a table holds.
  { name: "file", stored: "file", inputOnly: true },
  // Input-only: a column linking a whole table is a foreign key (tableRef).
  { name: "dbLink", stored: "<tableGuid>_mvpschema", inputOnly: true },
  { name: "geo.point", stored: "geo_point" },
  { name: "geo.multipoint", stored: "geo_multipoint" },
  { name: "geo.linestring", stored: "geo_linestring" },
  { name: "geo.multilinestring", stored: "geo_multilinestring" },
  { name: "geo.polygon", stored: "geo_polygon" },
  { name: "geo.multipolygon", stored: "geo_multipolygon" },
  { name: "enum", stored: "enum" },
  { name: "vector", stored: "vector" },
  { name: "object", stored: "obj" },
  { name: "tableRef", stored: "int", methodKey: "tableRef" },
];

/** The field-type catalog with each type's valid bind-methods joined in. */
function buildFieldTypes(): ManifestFieldType[] {
  return FIELD_DESCRIPTORS.map(({ name, stored, methodKey, inputOnly }) => ({
    name,
    stored,
    methods: Object.keys(FIELD_METHODS[methodKey ?? name] ?? {}),
    ...(inputOnly ? { inputOnly: true } : {}),
  }));
}

/** The value-pipeline filter catalog, derived from the generated filter sources. */
function buildFilters(): ManifestFilter[] {
  return FILTER_NAMES.map((name) => {
    const spec = FILTER_SPECS[name];
    const entry: ManifestFilter = { name, fl: `fl.${name}`, typed: !!spec?.args?.length };
    if (spec?.args?.length) entry.args = spec.args;
    if (spec?.result) entry.result = spec.result;
    if (spec?.group) entry.group = spec.group;
    if (spec?.description) entry.description = spec.description;
    return entry;
  });
}

const SPECS_BY_NAME = new Map(GENERATED_SPECS.map((s) => [s.name, s]));

/**
 * Stored statements that have a generated spec but whose public `s.` surface is
 * a hand-authored typed override (documented in prose above the catalog). The
 * generated bare-`Value` field signature is suppressed so the catalog renders
 * `(…) [special]` and defers to the typed entry — as it already does for the
 * hand-authored call family. The `[output]` flag is preserved.
 */
/**
 * Statement surfaces whose PARADIGM has been superseded, keyed by surface name to
 * the "use this instead" line the `## Legacy` index renders.
 *
 * Still registered, still authorable, still decoded out of a real workspace — so an
 * agent reading pulled code has to recognize them. They are withheld from the
 * per-namespace catalog and named-only in the legacy index, which is the same
 * split legacy VALUE constructors get: hiding one entirely is worse than useless,
 * because an agent that has never heard of it will "fix" what it does not
 * recognize.
 *
 * The realtime pair is the whole reason this exists at the statement level. The
 * two realtime layers use overlapping vocabulary — "channel", "realtime" — for
 * different objects, so an agent that sees both surfaces in one catalog will mix
 * them, and a mixed workspace fails at runtime rather than at compile.
 */
export const LEGACY_SURFACES: Readonly<Record<string, string>> = {
  "api.realtime_event":
    "publishes to the SUPERSEDED workspace-global realtime layer, NOT to a `realtimeChannel()` — its `channel` is a string against that layer, so pointing it at a current-layer channel path publishes into the void. Use `s.realtime.publish` instead: it names the owning `realtimeServer()`, so it addresses a real `realtimeChannel()`.",
};

export const OVERRIDDEN_SURFACES = new Set([
  "mvp:api_request",
  "mvp:streaming_api_request",
  "mvp:connect_webflow_api_request",
  "mvp:microservice_request",
]);

/**
 * What each statement's `as:` output var holds — the machine-readable companion
 * to the curated db.* "Runtime behavior" prose (and grounded in the same
 * `InferResponse` truth). Keyed by the public `surface`. Curated by design and
 * NOT exhaustive: it covers the statements whose result is stable and verified
 * (the db.* family, `security.check_password`, and the clearly-typed math/object/
 * array-predicate ops). A statement absent from this map simply has no `result`
 * in the manifest — read its `output` flag and the prose. `T` = the bound
 * `table()`'s `InferRow`. Types trace to `src/responses/infer.ts`; the db.* and
 * check_password shapes are verified against a live engine (#145).
 */
const STATEMENT_RESULTS: Record<string, { name: string; type: string; note?: string }> = {
  // db.* — mirrors the curated "Runtime behavior" block and InferResponse (#105/#145).
  "db.get": { name: "as", type: "InferRow<T> | null", note: "binds null on a miss, never throws" },
  "db.add": { name: "as", type: "InferRow<T>", note: "the full inserted row incl. id/created_at" },
  "db.edit": { name: "as", type: "InferRow<T>", note: "the full post-mutation row; throws NotFound on a miss" },
  "db.patch": { name: "as", type: "InferRow<T>", note: "the full post-mutation row; throws NotFound on a miss" },
  "db.add_or_edit": { name: "as", type: "InferRow<T>", note: "upserts and never misses" },
  "db.del": { name: "as", type: "null", note: "the engine deletes and returns no value; throws NotFound on a miss" },
  "db.has": { name: "as", type: "boolean" },
  "db.query": { name: "as", type: "InferRow<T>[]", note: "a paging envelope when metadata paging is on" },
  "db.bulk.patch": { name: "as", type: "InferRow<T>[]" },
  "db.bulk.delete": { name: "as", type: "number", note: "count of deleted rows" },
  // security.check_password binds a boolean (does the plaintext match the stored hash), #109/#145.
  "security.check_password": {
    name: "as",
    type: "boolean",
    note: "true when the plaintext matches the stored hash. ⚠ input.password double-hashes — pass input.text() plaintext",
  },
  // Clearly-typed declarative ops.
  "array.every": { name: "as", type: "boolean" },
  "math.add": { name: "as", type: "number" },
  "math.bitwise.and": { name: "as", type: "number" },
  "math.bitwise.or": { name: "as", type: "number" },
  "math.bitwise.xor": { name: "as", type: "number" },
  "object.keys": { name: "as", type: "string[]" },
  "object.values": { name: "as", type: "unknown[]" },
  "object.entries": { name: "as", type: "[string, unknown][]" },
};

function fieldsOf(spec: StatementSpec): ManifestField[] {
  return spec.rules.map((r) => {
    const f: ManifestField = {
      name: r.field,
      type: r.type,
      optional: r.optional || r.default !== undefined,
    };
    if (r.default !== undefined) f.default = r.default;
    return f;
  });
}

/** Build the full authoring manifest from the SDK's sources of truth. */
export function buildManifest(opts: { version?: string } = {}): Manifest {
  // `unpublished` descriptors are dropped here, so they reach neither the
  // emitted manifest, nor `llms.txt`, nor the coverage numerator below.
  const objectKinds: ManifestKind[] = KIND_DESCRIPTORS.filter((d) => !d.unpublished).map((d) => ({
    ...d,
    registered: isRegisteredKind(d.kind),
    // A published kind can still have unpublished sub-kinds (the two realtime
    // lifecycle trigger types under `trigger`), so filter that level too.
    ...(d.subKinds ? { subKinds: d.subKinds.filter((sub) => !sub.unpublished) } : {}),
  }));

  const statements: ManifestStatement[] = STATEMENT_SURFACES.map(([surface, storedName]) => {
    const spec = SPECS_BY_NAME.get(storedName);
    const overridden = OVERRIDDEN_SURFACES.has(storedName);
    const entry: ManifestStatement = {
      surface,
      storedName,
      sPath: sPathOf(surface),
      registered: isRegisteredStatement(storedName),
      declarative: spec !== undefined && !overridden,
    };
    if (spec) {
      entry.output = spec.output ?? false;
      // Overridden surfaces defer their signature to the hand-authored prose entry.
      if (!overridden) entry.fields = fieldsOf(spec);
    }
    // Curated result descriptor — attaches to declarative AND special surfaces
    // (the db.* family is `special`, so this must run independent of `spec`).
    // `hasOwn` guards a surface name colliding with an inherited Object member,
    // mirroring the FILTER_NOTES lookup below.
    if (Object.hasOwn(STATEMENT_RESULTS, surface)) entry.result = STATEMENT_RESULTS[surface];
    if (Object.hasOwn(LEGACY_SURFACES, surface)) entry.legacy = true;
    return entry;
  });

  const filters = buildFilters();

  return {
    name: "sidestep",
    version: opts.version ?? "0.0.0",
    description:
      "TypeScript SDK that compiles a typed Xano workspace into the importable packageExport JSON bundle.",
    coverage: {
      objectKinds: { implemented: objectKinds.filter((k) => k.registered).length, total: TOTAL_OBJECT_KINDS },
      statements: {
        implemented: statements.filter((s) => s.registered).length,
        total: TOTAL_STATEMENTS,
      },
      filters: { typed: filters.filter((f) => f.typed).length, total: filters.length },
    },
    values: { constructors: [...VALUE_CONSTRUCTORS], tags: TAGS },
    objectKinds,
    fieldTypes: buildFieldTypes(),
    statements,
    filters,
    cli: [...CLI_COMMANDS],
  };
}

/**
 * Statement fields whose default is security- or behavior-relevant and must stay
 * visible in the lean `llms.txt` — an agent that can't see the default would make a
 * wrong call. Keyed `"<sPath>:<field>"`. Every other field default is dropped from
 * `llms.txt` (it survives in `manifest.json`). Audit new statements for additions.
 *
 * `storage.create_*` default `access` to `"public"` (world-readable uploads) — the
 * worked example that motivated this carve-out: an agent shipping user uploads must
 * see the default is public, and it is not derivable from `access?: string`.
 */
const DEFAULT_KEEP = new Set<string>([
  "storage.create_image:access",
  "storage.create_attachment:access",
  "storage.create_audio:access",
  "storage.create_video:access",
]);

const fieldLine = (f: ManifestField, sPath: string): string => {
  const keepDefault = f.default !== undefined && DEFAULT_KEEP.has(`${sPath}:${f.name}`);
  return `${f.name}${f.optional ? "?" : ""}: ${f.type}${keepDefault ? ` = ${JSON.stringify(f.default)}` : ""}`;
};

/**
 * Curated, COMPLETE one-line notes for the typed filters whose signature alone
 * underspecifies behavior. The lean `llms.txt` filter catalog renders these in
 * place of the raw source descriptions — which are dropped from the primary (they
 * are 40% name-restating and 70% truncated mid-sentence) but retained in full in
 * `manifest.json`. Keyed by bare filter name. Mirrors the OVERRIDDEN_SURFACES /
 * DEFAULT_KEEP curated-override pattern; the completeness test (llms-filters) proves
 * every load-bearing filter has a note here or an entry in SELF_EVIDENT_FILTERS.
 */
export const FILTER_NOTES: Record<string, string> = {
  // "Direction" family — which operand is the subject is genuinely confusing.
  contains: "piped value is the subject text; the arg is the substring searched for",
  ends_with: "piped value is the subject text; the arg is the substring searched for",
  starts_with: "piped value is the subject text; the arg is the substring searched for",
  icontains: "case-insensitive; piped value is the subject, the arg is the substring",
  iends_with: "case-insensitive; piped value is the subject, the arg is the substring",
  istarts_with: "case-insensitive; piped value is the subject, the arg is the substring",
  // "empty" is a specific set of values, not just null.
  filter_empty: 'keeps entries that are not empty ("", null, 0, "0", false, [], {})',
  first_notempty: 'first value that is not empty ("", null, 0, "0", false, [], {})',
  // The `code`/lambda arg is a JS expression body, not a column path.
  map: "`code` is a JS expression body run per element",
  every: "`code` is a JS boolean expression run per element (true for all?)",
  some: "`code` is a JS boolean expression run per element (true for any?)",
  findIndex: "`code` is a JS boolean expression; returns the first matching index",
  lambda: "runs a JavaScript expression body",
  // Non-obvious names.
  epochms_transform: 'applies a relative shift (e.g. "+1 day") to the timestamp',
  unpick: "returns the object without the named keys (inverse of a pick)",
};

/**
 * Typed filters that ARE load-bearing (non-name-restating, complete source
 * description) but whose name + signature is self-evident, so they intentionally
 * carry no note. Recorded explicitly so the completeness test can prove every
 * load-bearing filter is a conscious keep-or-drop decision, not a silent gap.
 */
export const SELF_EVIDENT_FILTERS: ReadonlySet<string> = new Set([
  "array_fill",
  "array_fill_keys",
  "array_slice",
  "epochms_add_ms",
  "epochms_add_secs",
  "epochms_from_format",
  "range",
  "regex_quote",
  "filter_empty_text",
]);

/**
 * Render the manifest as `llms.txt` — a concise, link-free plaintext grounding
 * doc an agent can read to learn how to author a sidestep workspace.
 */
export function renderLlmsTxt(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`# ${m.name} v${m.version}`, "");
  lines.push(`> ${m.description}`, "");
  lines.push(
    "Author a Xano workspace in TypeScript: build typed objects, register them on a",
    "`new Xano()` instance, and call `.export()` to get one importable bundle. Compile",
    "with `sidestep export ./xano/index.js`.",
    "",
    `Coverage: object kinds ${m.coverage.objectKinds.implemented}/${m.coverage.objectKinds.total}, ` +
      `statement surfaces ${m.coverage.statements.implemented}/${m.coverage.statements.total}, ` +
      `filters ${m.coverage.filters.total} (${m.coverage.filters.typed} typed).`,
    "",
    "Full reference: this doc shows the authoring signature for every kind, statement, and",
    "filter. For exhaustive per-entry detail NOT shown here — a statement's full field schema",
    "with engine defaults, a filter's complete argument list, the engine `storedName` mapping —",
    "do a TARGETED lookup in the shipped `manifest.json` (grep or `jq` the one entry you need;",
    "it is ~55k tokens, so never read it whole).",
    "",
  );

  lines.push(
    "## Quickstart",
    "",
    "A complete workspace: a table, an auth-aware endpoint that writes a row, and a",
    "read endpoint. Authoring is **declarative def-objects** passed to factories —",
    "there is no callback/chaining builder.",
    "",
    "```ts",
    'import { workspace, apiGroup, query, table, input, f, ref, inp, auth, s } from "@sidestep/core";',
    "",
    "const users = table({",
    '  name: "users",',
    "  auth: true, // backs authentication",
    "  // `id` (int PK) + `created_at` (epochms) are auto-injected — don't declare them.",
    "  schema: {",
    "    email: f.email({ required: true }),",
    "    name: f.text(),",
    "  },",
    "  // Indexes: { type, fields: [{ name, op? }] }. `\"unique\"` is shorthand for `\"btree|unique\"`.",
    '  index: [{ type: "unique", fields: [{ name: "email" }] }],',
    "});",
    "",
    "const posts = table({",
    '  name: "posts",',
    "  schema: {",
    "    author: f.tableRef(users), // foreign key → users (NOT `ref`)",
    "    body: f.text({ required: true }),",
    "  },",
    "});",
    "",
    'const api = apiGroup({ name: "blog" });',
    "",
    "const createPost = query({",
    '  name: "create_post", verb: "POST", apiGroup: api, auth: users, // the auth table',
    "  input: { body: input.text({ required: true }) },",
    "  stack: [",
    '    s.db.add({ table: posts, row: { author: auth("id"), body: inp("body") }, as: "post" }),',
    "  ],",
    '  response: ref("post"),',
    "});",
    "",
    "const listPosts = query({",
    '  name: "list_posts", verb: "GET", apiGroup: api,',
    '  stack: [s.db.query({ table: posts, sort: [{ sortBy: "created_at", dir: "desc" }], as: "rows" })],',
    '  response: ref("rows"),',
    "});",
    "",
    'export default workspace("my-blog")  // a `new Xano()` with the name set',
    "  .registerTables([users, posts])",
    "  .registerApiGroups([api])",
    "  .registerQueries([createPost, listPosts]);",
    "```",
    "",
    "Compile: `sidestep export ./index.ts --out bundle.json` (or `writeBundle(app, path)`",
    "from `@sidestep/core/node` in code). The default export must be the `Xano` registry. The entry must be an",
    "ES module (sidestep defs are ESM-only): set `\"type\": \"module\"` in the nearest",
    "package.json or name the entry `.mts`. `npm init -y` writes `\"type\": \"commonjs\"`,",
    "which fails with a \"must be ES modules\" error until you switch it to module.",
    "",
    "Identity: object guids derive from `(type, name)`, so renames change identity.",
    "`sidestep export --lock` freezes every guid + api-group/toolset canonical in a",
    "committed `xano.lock` (auto-read once present; CI guard `--frozen-lock` fails",
    "instead of changing the lock). Fix-up subcommands:",
    "`sidestep lock rename <kind> <old> <new>` (kind = payloadKey or table/api_group),",
    "`sidestep lock prune <entry-file> [keys…] --yes`,",
    "`sidestep lock adopt <live-bundle.json> [--yes]` — all accept `--lock=<path>`.",
    "Programmatic use: call `seedLockOverrides(readLockFile(path))` BEFORE importing",
    "any def module — references bake guids at import time, so late seeding is a",
    "silent no-op (`resetLockOverrides` exists for tests).",
    "Development workflow: opt in EARLY — run `sidestep export --lock` once and COMMIT",
    "`xano.lock` beside the entry file; every later export then keeps identities",
    "stable across renames and environments. To rename an object: rename in code,",
    "export (stderr prints the exact fix-up), run `sidestep lock rename <kind> <old>",
    "<new>`, export again — the original guid is emitted under the new name, so the",
    "engine renames in place instead of delete+create. Taking over an existing",
    "workspace: `sidestep lock adopt <its-packageExport.json>` first, then export.",
    "",
    "## Deploy",
    "",
    "`sidestep init` → `sidestep deploy` → URL. Each `deploy` runs the same compile",
    "pipeline as `export` (honoring `xano.lock`), then imports the result into a live",
    "environment and prints its URL.",
    "⚠ Every deploy is a FULL REPLACE: it clears that environment's workspace — objects",
    "AND records — before importing. The blast radius is a disposable environment, not a",
    "production workspace, but confirm with the user before the first run.",
    "",
    "**Two destinations, and the choice changes more than the target.**",
    "",
    "- `--dest ephemeral` (DEFAULT) — a NAMED, workspace-scoped, auto-expiring tenant",
    "  (~1h; `--expires-hours` 1–72 at create time). The active one is tracked in",
    "  `./.xano/ephemeral.json`, so deploying again REFRESHES it and the URL is unchanged;",
    "  if it expired or was swept, a fresh one is created and the new URL is called out.",
    "  `--static` puts the frontend ON THE EPHEMERAL, so backend and frontend share one",
    "  disposable environment.",
    "- `--dest sandbox` — your single throwaway tenant, no expiry. `--static` puts the",
    "  frontend on your OWN (parent) workspace instead, because the sandbox tenant does",
    "  not serve static hosting.",
    "- `sidestep release` promotes to your instance workspace — COMING SOON, pending a",
    "  record-preserving import, since a release must not wipe production data the way a",
    "  full replace would.",
    "",
    "Nothing from the server is written back into `xano.lock` (a deploy target is a",
    "separate workspace, so its identities must not pollute yours). Deploying an ENTRY",
    "FILE still updates the local lock via the shared compile step, exactly as `export`",
    "does — only when a lock exists or `--lock` is passed.",
    "",
    "**Frontend wiring.** `--static <dir>` injects the DEPLOYED env's backend URL into the",
    "build's root index.html as `window.XANO_HOST`, before the app bundle runs, so the",
    "frontend needs no rebuild to target an env. Read it at runtime with a build-time",
    "fallback:",
    "  const HOST = (typeof window !== 'undefined' && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;",
    "⚠ A static host serves these files verbatim, so everything injected is PUBLIC — base",
    "URLs and publishable keys only, never secrets. Secrets go in backend env, read",
    "server-side via `env(name)`.",
    "",
    "**Full CLI surface:** `sidestep <command> --help` lists every command, flag, and",
    "default; the shipped `manifest.json` carries the same in its `cli` array. This doc",
    "does not duplicate it — it covers what you must know to AUTHOR a workspace.",
    "**Recommended style:** reach statements through the `s` namespace",
    "(`s.db.add`, `s.math.add`, …) — one discoverable, tab-completable surface. The",
    "flat factory aliases (`dbAdd`, `dbQuery`, `setVar`, `mathAdd`, …) are exported",
    "and identical in output; prefer `s.*` in new code so examples stay consistent.",
    "",
  );

  lines.push(
    "## Gotchas",
    "",
    "Non-obvious authoring rules:",
    "",
    "- **No callback builder.** Flat def-objects + `register*`, not",
    "  `workspace(w => w.table(...))`. `workspace(name)` returns a named `new Xano()`;",
    "  tables are `table({ schema: { col: f.text() } })`.",
    "- **Foreign key is `f.tableRef(table)`, not `ref`.** `ref(name)` references a",
    "  stack variable (a value); `f.tableRef` is the column constructor.",
    "- **Reference-helper picker:** `ref` = stack var (`as:` output), `inp` = input,",
    "  `col` = table column (in `db.query` `where`), `auth(\"id\")` = the caller,",
    "  `c.*` = a constant. Pick by what you're pointing at.",
    "- **Drilling into a maybe-null `db.get` result 500s — use `ref(path, { safe: true })`.**",
    "  `db.get` binds `null` on a no-match, but a nested `ref(\"owner.user_id\")` resolves",
    "  `$owner.user_id` in one lookup and raises a runtime \"Unable to locate var\" (HTTP 500)",
    "  when `owner` is null — so an ownership/existence guard throws instead of failing",
    "  cleanly. Either guard existence first (`expr(ref(\"owner\"), \"!=\", c.null())`,",
    "  or a `db.has`/`db.query`-count precondition), or drill with the null-safe opt-in:",
    "  `expr(ref(\"owner.user_id\", { safe: true }), \"=\", auth(\"id\"))` compiles through the",
    "  `get` filter and yields `null` (guard reads `false`) rather than 500ing.",
    "- **DB reads are field-match, not `where`-expr.** `db.get`/`db.edit`/`db.del`/",
    "  `db.has`/`db.patch` match one field: `{ fieldName, fieldValue }` (`fieldName`",
    "  defaults to the PK `id`). Only `db.query` takes a `where`/`additionalWhere`",
    "  `expr(...)`; writes (`db.add`/`db.edit`/`db.add_or_edit`) take a `row`/`data`.",
    "  See the **Statements › specials** signatures below.",
    "- **Single-field only — no composite match.** These ops match exactly ONE field;",
    "  there is no two-field form (the engine's by-field lookup takes a single",
    "  predicate). For a `(a, b)` existence/fetch — e.g. dedupe a `(habit, date)`",
    "  check-in — use `db.query({ where: [expr(col(\"habit\"), \"=\", ...), expr(col(\"date\"), \"=\", ...)], as })`",
    "  (a `where` array is ANDed) and branch on the result, rather than pushing the",
    "  check to the client.",
    "- **System columns are auto-injected.** `id` + `created_at` are prepended to",
    "  every table (`system: true` by default); declaring them by hand is redundant.",
    '  `id` is an `int` PK by default; pass `idType: "uuid"` on the table for a uuid key.',
    "  Both are valid targets wherever a column name is accepted — `db.query` `sort`/",
    "  `output`, a `db.get`/`edit`/`del` `fieldName`, etc. (the column-name type is",
    "  `keyof schema | \"id\" | \"created_at\"`), and both appear in `InferRow<typeof table>`.",
    "- **Seed a table's starting rows with `table({ seed })`.** `seed` takes rows",
    "  typed against the table's schema as a WRITE shape (a column without",
    "  `required: true`, and the system columns, may be omitted; `null` needs",
    "  `nullable: true`) — either inline",
    "  (`seed: [{ name: \"…\" }]`) or, preferred for large/sensitive data, a deferred",
    "  thunk (`seed: () => import(\"./seed.json\")`, optionally async — a JSON module's",
    "  `.default` is unwrapped for you). Every form keeps the table's row and",
    "  column-name typing intact (`InferRow`, db-statement column checks). The thunk keeps",
    "  seed VALUES out of any frontend bundle that value-imports the def, resolving them",
    "  ONLY in the Node deploy path. Deploy is a full replace, so re-deploying re-seeds",
    "  cleanly (no duplication). For an int PK,",
    "  omit `id` and rows auto-number `1..N`; supplying `id` pins it (engine preserves",
    "  it, resets the sequence past the max). All-or-nothing — mixing explicit and",
    "  omitted `id` throws. uuid/`system:false` PKs are the author's to supply.",
    "- **`use_xdo` storage mode.** Workspace setting (`registerWorkspace({ use_xdo })`,",
    "  default `false`) controlling whether fields are stored as JSON under the `xdo`",
    "  column (`true`, adds a `gin(xdo)` index) or as real columns (`false`, no gin).",
    "  Tables inherit it; override per-table with `table({ useXdo })`. Resolved at",
    "  `export()`, so the workspace and tables can be registered in any order.",
    "- **Self-referencing tables** need the bare-name form: inside `tweets`'s own",
    '  schema, write `f.tableRef("tweets", { type: "int" })` — the `const tweets`',
    "  handle isn't assigned yet, so the handle form throws \"used before declaration\".",
    "- **Same-name siblings collide.** Object guids derive from `(type, name)` and",
    "  ignore a query's `verb`, so a `GET` and `POST` both named `posts` clash;",
    "  `export()` throws on the collision — give them distinct names or an explicit",
    "  `guid`.",
    "- **`export()` vs `emitBundle()` vs `writeBundle()`:** `writeBundle(app, path)`",
    "  writes it to disk; `export()` returns the bundle object;",
    "  `emitBundle()` returns the pretty JSON string. The `node:fs` writers",
    "  (`writeBundle`/`writeArtifact`) and lock-file I/O import from `@sidestep/core/node`,",
    "  NOT the browser-safe `@sidestep/core` entry (which a frontend can import query",
    "  defs from to use `getPath()`/`InferInput` with no Node built-ins in the bundle).",
    "- **Client bundle size / tree-shaking.** `@sidestep/core` is `sideEffects: false`",
    "  and the `.` entry pulls no Node built-ins, so a bundler drops the SDK exports a",
    "  frontend doesn't use. But importing a query **def** for its `getPath()`/`verb`",
    "  also pulls whatever its `stack` references: the `s.*`/`c.*` factory CALLS run at",
    "  module load to BUILD the def, so they can't be tree-shaken away. Types are free.",
    "  To keep a client bundle minimal, put",
    "  route-facing metadata a frontend needs (the def handle for `getPath()`/`verb`, and",
    "  `type` imports) in a module separate from stack-heavy authoring, and `import type`",
    "  wherever you only need the shape.",
    "- **Intra-workspace imports use `.js` specifiers** (`../tables/links.js`), not",
    "  extensionless — the defs compile under `moduleResolution: bundler`. Add the `.js`.",
    "- **Verifying a def outside a bundler.** Inside a bundler (Vite/webpack) importing a",
    "  query def to read `getPath()`/`verb` just works. To spot-check from Node, run a REAL",
    "  file with `tsx <file.ts>` **from inside the project root** — not `tsx -e \"import …\"`",
    "  (its CJS-preparse mis-resolves the package `exports` map → ERR_PACKAGE_PATH_NOT_EXPORTED),",
    "  and not bare `node file.ts` (chokes on the `.js`-specifier intra-workspace imports the",
    "  sidestep CLI's own loader resolves). Running from outside the project root also breaks",
    "  the `@sidestep/core` specifier resolution.",
    "- **Block specials nest a `body`, not a `stack`.** `s.for`/`s.foreach`/",
    "  `s.while`/`s.switch`/`s.try_catch`/`s.db.transaction`/`s.expect.to_throw`",
    "  take their sub-stack as `body` (`try`/`catch`/`finally` for `try_catch`);",
    "  `s.group(body)` and `s.util.post_process(body)` take it **positionally**.",
    "  `s.for` is **count-bounded** (`{ as, count, body }`), not from/to. See the",
    "  **Specials — authored signatures** block below.",
    "- **MCP servers & agents are distinct root kinds** that both persist under the",
    "  `toolset` payload key (so a same-name pair collides). `mcpServer({...})` exposes",
    "  tools over MCP (auth is per-tool — no server-level gate); `agent({...})` carries a",
    "  typed `llm` block — and so may an `mcpServer`, since the two are ONE stored",
    "  object distinguished by `type`. Their `tools` take a `tool()` handle (or name), resolved to the",
    "  tool's guid like the call family; a raw numeric `id` is an escape hatch.",
    "- **`task.schedule` is an array** of `{ startsOn, freq?, repeatEnabled?, endsOn?, endsEnabled? }`",
    "  (`ScheduleDef[]`), not a single `{ type, value }`. `freq` is seconds; `startsOn`/",
    "  `endsOn` are **ISO-8601 string** timestamps (`\"2026-01-01T00:00:00Z\"`), not epoch",
    "  numbers (passing `0` is a type error).",
    "- **`get_input`/`get_raw_input` read the whole payload**, not one named input",
    "  (args are `{ as?, encoding?, excludeMiddleware? }` — no `name`). For a single",
    "  input use `inp(\"name\")`.",
    "- **Build regex-filter patterns with `c.regex(body, flags?)`, never `c.text`.**",
    "  The regex filters (`regex_test`/`regex_match`/`regex_replace`/…) are pattern-piped",
    "  PHP `preg_*`: the piped value is the PATTERN and must be delimiter-wrapped. A bare",
    "  `c.text(\"^[^@\\s]+@...$\")` is an invalid pattern that matches *nothing* for every",
    "  input, so a precondition on it silently rejects all values (valid ones included).",
    "  `c.regex(\"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$\", \"i\")` wraps + escapes it for you (accepts a",
    "  JS `RegExp` too: `c.regex(/^…$/i)`), and `withFilters` throws on a bare `c.text`",
    "  pattern pointing here. Better still, prefer a native typed input",
    "  (`input.email({...})`) over hand-rolled validation.",
    "- **Declare inputs with `input.<type>()`, read them with `inp(\"name\")`.** In an",
    "  `input: {}` block the columns are `input.text({...})` etc.; `inp` is the *value",
    "  ref* that reads an input inside the stack (`inp(\"name\")`). Writing `inp.text({...})`",
    "  in the input block is a compile error, caught at typecheck.",
    "- **Don't take a password through `input.password` on login — it double-hashes.**",
    "  An `f.password()` column hashes on write, and `input.password` *also* hashes the",
    "  submission on bind, so `s.security.check_password` compares two different hashes",
    "  and a correct password always fails (`ok:false` on a found row). Take the submitted",
    "  password as `input.text()` on both signup and login and pass the plaintext straight",
    "  to `check_password` (which does the comparison hash itself).",
    "- **Agents authenticate with env vars — never `sidestep login`.** `login` blocks on a",
    "  browser consent no agent can complete. Set `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID`",
    "  (both come from `.xano/auth.json`; the instance is read from the token's `aud`) and",
    "  run `deploy` directly — it uses a non-interactive refresh grant. Refresh tokens rotate",
    "  on use, so a stored one may be single-use. For hand-authored automation credentials",
    "  write `.xano/auth.json` yourself: `{ \"type\": \"token\", \"instance_base_url\": \"https://…\",",
    "  \"workspace_id\": <n>, \"meta_api_token\": \"…\" }` — no login, no refresh.",
    "- **Event-driven objects deploy but DO NOT FIRE in the sandbox.** A `task` (scheduled),",
    "  an `mcpServer`, and every trigger — `tableTrigger` included, so an insert/update/delete",
    "  on a bound table does NOT run its stack — import cleanly but never execute there, and",
    "  there is no way to fire one manually. So an event-driven design (screen-on-insert, cron",
    "  cleanup, MCP tool call) silently does nothing. VERIFY THE LOGIC OUT OF BAND: factor the",
    "  body into a `defineFunction` (or a callable `query`) and invoke it directly — a",
    "  `tableTrigger` that screens a row on insert should delegate to a function a `query` can",
    "  also call via `s.function.run`, and you assert against that. Only synchronously-invoked",
    "  objects (queries, functions, and the agents an endpoint calls with `s.ai.agent.run`)",
    "  actually run in the sandbox.",
    "- **Reading a pulled tree.** `codegen` emits objects as FACTORY calls (`table({...})`,",
    "  `query({...})`, …) — the form you author by hand — so inference survives the round trip.",
    "  Three shapes read differently and must not be \"fixed\": a trigger no factory expresses",
    "  (the realtime types, or a non-default `history`) stays `{...} satisfies TriggerDef`; a",
    "  statement the catalog cannot model round-trips verbatim through `raw()`",
    "  (`@sidestep/core/codegen`); and an object ALREADY EMPTY upstream decodes to a def with",
    "  no `stack`, reported as `empty-source` — faithful, not a decode failure. ⚠ Workspace env",
    "  var VALUES ride inline in `xano/workspace.ts`, so treat a pulled tree as secret-bearing.",
    "",
  );

  lines.push("## Object kinds", "");
  lines.push("Author with the factory, register on the Xano instance, lands under the payload key. Each line ends with a one-liner on what the primitive is.", "");
  for (const k of m.objectKinds) {
    if (k.subKinds && k.subKinds.length > 0) {
      // Fan a multi-factory kind out into one root-level line per sub-kind so
      // each reads as a first-class primitive (they share one payload key +
      // register method, discriminated by `obj_type`).
      for (const sub of k.subKinds) {
        // Legacy sub-kinds are withheld here and named in `## Legacy` instead.
        if (sub.legacy) continue;
        lines.push(
          `- ${k.kind} (${sub.objType}): \`${sub.authorFactory}\` → \`Xano.${k.registerMethod}\` → payload \`${k.payloadKey}\` — ${sub.description}`,
        );
      }
    } else {
      lines.push(`- ${k.kind}: \`${k.authorFactory}\` → \`Xano.${k.registerMethod}\` → payload \`${k.payloadKey}\` — ${k.description}`);
    }
  }
  lines.push("");

  // Curated def-object shapes for the high-traffic authorable kinds plus the
  // `expr`/`response` helpers. These are hand-authored interfaces (not in the
  // generated statement specs), so — like the specials block above — they're
  // maintained from the `*Def` interfaces in `src/kinds/` + `src/responses/`.
  lines.push(
    "## Object def shapes",
    "",
    "The def-object passed to each factory. `?` = optional. `input` is keyed by",
    "input name (`input.<type>(opts?)`); `stack` is `Statement[]` (`s.*`); `response`",
    "is a `ResponseDef` (see **Responses** below). Object identity is `guid?` —",
    "omit it and it derives from `name` (set it to survive a rename).",
    "",
    "- `defineFunction({ name, guid?, description?, docs?, workspace?, input?, stack?, response? })`",
    "- `query({ name, verb, apiGroup?, guid?, auth?, input?, stack?, response?, responseType?, apiEnabled?, disabled?, cache?, description?, docs? })`",
    "  - `verb`: `\"GET\" | \"POST\" | \"PUT\" | \"PATCH\" | \"DELETE\" | \"HEAD\"` (required).",
    "  - `apiGroup`: an `apiGroup()` def handle (or its name) — binds by guid, stable across syncs. Raw numeric `apiGroupId?` is the escape hatch and wins if both given.",
    "  - `auth`: `false` (no auth) or an auth-table id; `responseType`: `\"standard\" | \"stream\"` (default `standard`).",
    "  - `name` is the endpoint PATH within the group. A `{param}` segment is a URL PATH PARAM bound to the input of the same name, and segments chain: `name: \"blog/{slug}/review/{review_id}\"` + `input: { slug: input.text(), review_id: input.int() }`. Read it with `inp(\"slug\")` like any other input. Every `{param}` MUST have a matching input or `query()` THROWS — Xano treats an unbound marker as inert route text, so the endpoint would answer on the path and see nothing. A `{param}` is always a WHOLE segment (`\"post-{slug}\"` is an error) and its type must fit one segment (no object/list/json/file/geo/vector); there are no wildcards or patterns. `required: true` is NOT demanded (the engine's editor leaves path inputs unmarked). Inputs absent from the path are ordinary query-string/body params.",
    "  - **Client recipe:** `q.getPath({ params: { slug: \"hello\" } })` → `/api:<canonical>/blog/hello` — never interpolate by hand (a value containing `/` would address a different endpoint; `getPath` throws instead). The keys are typed from the literal `name`, so a typo is a compile error. The HANDLE's `q.toSearchParams(input)` drops path params for a GET; the free `query.toSearchParams(input)` has no view of the route and keeps every key.",
    "- `apiGroup({ name, guid?, canonical?, description?, docs?, swagger?, apiGroupEnabled?, documentation?, cors? })` — a query container; register it and bind queries to it via their `apiGroup`.",
    "  - `cors?`: `{ mode?, allowOrigins?: string[], allowHeaders?: string[], allowCredentials?, maxAge?, allowMethods?: { get?, post?, put?, patch?, delete?, head? } }`.",
    "- `defineFunction`/`query`/`apiGroup` above cover the queries+tables core; the five below are the \"reach past that\" primitives (agents, tools, tasks, middleware, MCP servers). Same envelope conventions (`guid?`, `description?`, `docs?`, `tags?`, `history?`) unless noted.",
    "- `task({ name, guid?, description?, docs?, datasource?, active?, tags?, history?, schedule?, stack?, middleware? })` — a scheduled background job (function-like `stack`, no `input`/`response`).",
    "  - `schedule?`: a `ScheduleDef[]` (NOT a single object) — `{ startsOn, freq?, repeatEnabled?, endsOn?, endsEnabled? }`. `startsOn`/`endsOn` are **ISO-8601 string** timestamps (`\"2026-01-01T00:00:00Z\"`), not epoch numbers; `freq` is the repeat interval **in seconds** (default `86400` = daily); `endsOn` present ⇒ the schedule has an end. `endsEnabled?` defaults to that and is recovery-only — state it to reproduce a stored schedule that remembers an end date with the gate OFF. Deploys but does NOT fire in the sandbox (see the sandbox NOTE above).",
    "- `middleware({ name, guid?, description?, docs?, resultStrategy?, exceptionPolicy?, tags?, history?, input?, stack?, response? })` — a pre/post interceptor (function-like `stack`); attach it via a host's `middleware: { pre, post }`.",
    "  - `resultStrategy?`: `\"merge\" | \"replace\"` (default `merge`) — how the middleware `response` folds into the host's.",
    "  - `exceptionPolicy?`: `\"silent\" | \"rethrow\" | \"critical\"` (default `\"silent\"` — a throw is SWALLOWED, so a guard is NOT enforced). A rate-limit/auth guard wants `\"rethrow\"` (throw aborts the request, surfaces the status); `\"critical\"` also skips the `post` chain.",
    "- `tool({ name, guid?, description?, instructions?, docs?, enabled?, tags?, history?, input?, stack?, response?, middleware? })` — a function-like operation (`input`/`stack`/`response`) that a toolset (MCP server or agent) exposes. Register it, then reference it from a toolset's `tools`.",
    "- `mcpServer({ name, guid?, description?, instructions?, docs?, enabled?, canonical?, spec?, tags?, history?, tools?, llm?, output? })` — an MCP toolset. `llm?`/`output?` are the same blocks `agent()` takes and are usually absent: an MCP server and an agent are ONE stored object distinguished by `type`, so a server that carries LLM settings can say so. Returns a handle with `getPath()`/`getUrl(baseUrl)` for the Streamable-HTTP endpoint. Deploys but does NOT fire in the sandbox.",
    "  - `tools?`: a `ToolsetToolRef[]` — `{ tool: <a tool() handle or its name>, enabled?, auth? }` WRAPPERS, not bare handles. `auth` names an auth **table** (a `table({ auth: true })` handle or its name) — Xano's ONLY MCP auth surface (per-tool; there is no server-level gate).",
    "- `agent({ name, guid?, description?, docs?, enabled?, canonical?, tags?, history?, llm, tools?, output? })` — an LLM orchestrator. No top-level `instructions`/`prompt`/`spec` — the prompt lives under `llm`. Invoke from a stack with `s.ai.agent.run({ agent, args })`.",
    "  - `llm` (REQUIRED): typed provider settings, a discriminated union on `type` (`\"xano-free\" | \"anthropic\" | \"openai\" | \"google-genai\"`). Shared fields: `systemPrompt?`, `maxSteps?` (default `5`), and `prompt?` XOR `messages?`; plus provider fields (`apiKey?`, `model?`, `temperature?`, `reasoningEffort?`, …). String fields accept Twig placeholders — `{{ $args.x }}` for run inputs (the `args` of `s.ai.agent.run`), `{{ $env.NAME }}` for env vars.",
    "  - `tools?`: same `ToolsetToolRef[]` `{ tool, enabled?, auth? }` wrappers as `mcpServer`.",
    "  - `output?`: `{ schema: Record<string, input.*>, enabled? }` — structured-output schema. `schema` is a named-field record authored with the `input.*` catalog, exactly like a `defineFunction`/`query` `input:` map (the stored `structuredOutputsSchema` is the same wire shape as function inputs). e.g. `output: { schema: { priority: input.enum([\"low\",\"high\"]), summary: input.text() } }`. When you pass the agent *handle* to `s.ai.agent.run({ agent })`, `.result` is typed straight from this schema — no `resultShape` witness needed (the shape is declared once). `resultShape` remains only to override that, or to type an agent referenced by bare name.",
    "  - **Run + read recipe (`s.ai.agent.run`):** bind the run to a var (`s.ai.agent.run({ agent, args, as: \"run\" })`) — it produces a rich envelope, and the completion is at **`.result`**. Read one structured field with a dotted ref (`response: ref(\"run.result.priority\")`) or the whole completion (`ref(\"run.result\")`, typed from `output.schema`); persist it in a later step the same way (`s.set_var({ name, value: ref(\"run.result.summary\") })`). `args` is a plain object of run inputs (`{ topic: inp(\"topic\") }` — raw literals are fine, e.g. `{ max_steps: 3 }`) surfaced to the agent as `{{ $args.topic }}`. Tool-call / per-step data (when tools ran) rides `.toolCalls` / `.steps` on the same envelope — both optional, absent or empty when no tools executed.",
    "- **Realtime** — the only three-level chain: `realtimeServer` owns `realtimeChannel`s, which own `realtimeMessage` handlers. Pass the HANDLE, not a name (a channel path is unique only within its server).",
    "  - `realtimeServer({ name, guid?, description?, enabled?, canonical?, tags?, history? })` — the container.",
    "    - `enabled` defaults to **false** — the one `enabled` in the SDK that does.",
    "    - An enabled server with no active channel still refuses the handshake.",
    "  - `realtimeChannel({ name, server, guid?, description?, active?, input?, anonymousClients?, presence?, publish?, conversation?, delivery?, rateLimit?, tags?, history? })`",
    "    - `name` is a PATH (`\"lobby\"`, `\"rooms/{room_id}\"`); `input` types its `{param}` segments, NOT the payload. Every `{param}` MUST have a matching input or `realtimeChannel()` THROWS.",
    "    - Matching is STRICT: a literal segment beats a param (`rooms/lobby` and `rooms/{room_id}` coexist); segment counts must be EQUAL (`rooms/{room_id}` does NOT match `rooms/42/edit`); literals are CASE-SENSITIVE; an empty segment is REJECTED, not collapsed (a leading/trailing/doubled `/` matches nothing). `getChannel()` throws on an empty or slash-bearing param for that reason.",
    "    - An INACTIVE channel reports the same error as a nonexistent one — deactivating leaks nothing.",
    "    - `anonymousClients` is gated TWICE: the server admits the connection, then the channel admits the join. Setting it here alone is not enough.",
    "    - `publish?: { who?: \"nobody\"|\"anyone\"|\"authenticated\", direct? }` — `who` defaults to `nobody`: nobody can publish until you set it. `direct` (default false) lets a client address ANOTHER CLIENT via a frame's `options.socketId`, and is checked BEFORE `who`.",
    "    - `conversation?: { enabled?, limit?, ttl? }` — the client-visible TRANSCRIPT replayed to a joiner (distinct from `history`, which is execution history). ⚠ `limit` DEFAULTS TO 0 AND 0 MEANS OFF: `{ enabled: true }` alone records nothing and replays nothing, silently. `ttl` is an IDLE expiry of the WHOLE transcript, refreshed by every write (an active channel never ages out; a silent one loses all of it at once) — NOT a per-message age cap.",
    "    - `delivery?: { guarantee?: \"at_most_once\"|\"at_least_once\", perRecipient? }` — `perRecipient` is independent of the guarantee, is a NO-OP unless the channel declares a `deliver` trigger, and costs a stack PER RECIPIENT PER MESSAGE.",
    "    - `rateLimit?: { messagesPerMinute? }` — 0 = unlimited, checked BEFORE the handler runs. A COST guardrail, not a security control: an anonymous client is bucketed per CONNECTION (reconnecting resets it), and it fails OPEN when its store is down.",
    "  - `realtimeMessage({ name, channel, server?, guid?, description?, active?, auth?, deliverTo?, input?, middleware?, stack?, response?, history?, disabled?, tags? })` — the invocable unit (the realtime analogue of a query).",
    "    - `input` types the message PAYLOAD. `server` is required only when `channel` is a bare path.",
    "    - `deliverTo?`: `\"channel\"` (default) | `\"sender\"` | `\"others\"` | `\"explicit\"`. ⚠ `\"explicit\"` still delivers to NOBODY — nothing selects recipients from inside a handler, and `s.realtime.publish` (which originates an event INTO a channel) is not a substitute.",
    "    - Only `\"channel\"`/`\"others\"` fan out AND are written to the `conversation` transcript — a `\"sender\"` response is invisible to every future joiner.",
    "  - **Both input surfaces read as ordinary inputs:** `inp(\"body\")` for a payload field, `inp(\"room_id\")` for the channel's `{room_id}`. No session lookup, no frame parsing.",
    "    - A path param is bound ONCE at join and read from the connection thereafter, never from the frame — a sender cannot claim a room it did not join. The same values reach a channel `join`/`leave` trigger's stack.",
    "  - `s.realtime.get_session({ as })` — the CALLER's realtime session for the current frame. FLAT shape:",
    "    - `authenticated` bool · `client_id` text (the AUTHED ROW ID as text, `\"\"` anonymous) · `dbo_id` int (0 anonymous) · `socket_id` int (transport id) · `channel` text (resolved path, `\"\"` in a server trigger) · `params` object (bound path params, `{}` when none — `ref(\"session.params.room_id\")`) · `extras` object · `opened_at` decimal.",
    "    - Works in a realtime MESSAGE stack and in CHANNEL and SERVER trigger stacks; off that path it degrades to an anonymous session.",
    "    - For a path param prefer `inp(\"room_id\")`. Reach for the session when you need the CONNECTION (identity/extras) — \"who is this sender\" on an anonymous-client channel.",
    "    - ⚠ THREE UNRELATED THINGS ARE CALLED A CLIENT ID: `session.client_id` (app-facing identity), `session.socket_id` (transport), and a frame's `options.client_id` (the at_least_once CURSOR handle). Conflating the first and last breaks at_least_once for anonymous clients.",
    "  - `s.realtime.publish({ server, channel, data, message?, authTable?, authId? })` — the PUSH direction: originate a server-authored event onto a channel from ANY stack, no client frame first.",
    "    - `server` is the handle or its NAME (resolved by name, not guid); `channel` is the FILLED-IN path (`channel.getChannel({ room_id: 42 })`), never the template. Only these two throw, at author time.",
    "    - DELIVERY-ONLY — fanned out as-is; does NOT invoke a `realtimeMessage()` handler even when `message` names one (a channel `deliver` trigger still runs).",
    "    - SERVER-AUTHORITATIVE — bypasses `publish.who`, which governs CLIENTS. Authorize in your own stack.",
    "    - ⚠ FAIL-SOFT — a missing/disabled server or dead bus is swallowed engine-side, so a mis-targeted publish is SILENT with no result to check.",
    "    - `authTable`/`authId` are ASSERTED attribution on the frame — not a credential, nothing validates them.",
    "  - **Client recipe (derive, never hardcode):**",
    "    - `server.getUrl(baseUrl)` → `wss://<host>/ws/<canonical>` — accepts the `https://…` instance base URL and normalizes the scheme. `channel.getChannel({ room_id: 42 })` → `\"rooms/42\"`, the path that goes in a frame's `channel` field. Both throw rather than guess. A canonical is minted by `sidestep export --lock`.",
    "    - Auth is a bearer token passed as the websocket SUBPROTOCOL: `new WebSocket(url, token)`. No token = an anonymous client, admitted only where `anonymousClients: true`.",
    "    - Frames are JSON `{ action: \"join\"|\"leave\"|\"broadcast\"|\"ack\"|\"ping\"|\"presence\", channel, type?: <message name>, payload?, options?, id? }`. You must `join` before you may `broadcast`, and the server's context is ready only a moment after `open` — an immediate first frame is refused.",
    "    - `options` is `{ socketId?, client_id?, channel? }` — `socketId` addresses another client directly (needs `publish.direct`), `client_id` is the at-least-once cursor handle, and `options.channel` WINS over a top-level `channel`.",
    "    - ⚠ KEEP THE SOCKET ALIVE: an idle connection is REAPED after ~10 minutes. A LISTEN-ONLY client (a feed or dashboard that joins and rarely publishes) MUST send `{ action: \"ping\" }` (answered `pong`) or any frame periodically or it silently drops.",
    "    - Server frames: `join` (ack `{ joined: true, params }`, + `cursor`/`resumed` on at_least_once) · `message` · `replay` · `broadcast` · `presence_full`|`presence_join`|`presence_leave` · `conversation_start`|`conversation_end` (replayed frames flagged `conversation: true`) · `pong` · `ack` · `error`.",
    "    - ⚠ `broadcast` is a RECEIPT to the sender, not a delivery confirmation: `payload.delivered_local` counts recipients on the ANSWERING NODE ONLY, not the channel. It also carries `id` on at_least_once and `dropped: true` when the handler returned null.",
    "    - `error` carries `payload.message`, plus `code`/`limit`/`retry_after` when rate limited. `rate_limited` is the ONLY code — do NOT switch on `code`.",
    "    - An `error` is a per-frame refusal, NOT a disconnect — EXCEPT a failed handshake and a REFUSED `connect` trigger, which each send one and then CLOSE with code 4401.",
    "  - **Tenant instances (isolated DB):** a tenant's realtime objects live in the TENANT's database, so BOTH halves of a client must name the tenant.",
    "    - Socket: `server.getUrl(base, { tenant })` → `/ws/<tenant>:<canonical>`. ⚠ A bare canonical on a tenant host resolves against the INSTANCE workspace instead.",
    "    - That colon form is PECULIAR TO THE SOCKET. Every other tenant URL gives the tenant its OWN segment — the HTTP half of the same client is `https://<host>/tenant/<tenant>/api:<canonical>/…`. NO request header is required for either.",
    "    - Because the shapes differ, `getUrl` TRANSLATES a tenant base URL instead of concatenating: pass the `https://<host>/tenant/<name>` that `sandbox details` prints (and that deploy injects as `window.XANO_HOST`) and the tenant is LIFTED into the socket form. So `getUrl(window.XANO_HOST)` needs no `{ tenant }`, and a CONFLICTING `{ tenant }` alongside it throws.",
    "    - Still pass `{ tenant }` explicitly for a tenant on its OWN DOMAIN — the hostname carries it for HTTP, but there is nothing in the URL for the socket to lift.",
    "    - ⚠ Tokens are tenant-scoped (audience `<tenant>:<license>`, not the bare license), so one minted through the instance workspace is REJECTED by a tenant's realtime server — authenticate and dial through the same tenant.",
    "  - **Presence frames** (a `presence: true` channel only):",
    "    - `presence_full` carries `payload.members` — an ARRAY holding the WHOLE roster, including the receiving client. `presence_join`/`presence_leave` carry a single `payload.member`.",
    "    - A member is `{ id, dbo_id, authenticated, extras, joined_at }`: `id` the auth row id as a string (`\"\"` anonymous), `dbo_id` the auth table's id (`0` anonymous), `extras` the connection's extras object, `joined_at` epoch SECONDS.",
    "    - Render from `presence_full`, then apply the deltas. The roster counts MEMBERS, not connections (refcounted per identity — a second tab fires no second `presence_join`).",
    "    - Join order: `join` ack → `presence_full` → (others get `presence_join`) → conversation replay → `replay` frames.",
    "    - A joined client can re-request the snapshot any time with `{ action: \"presence\", channel }`, answered to the SENDER only. A socket that never joined is REFUSED — the roster is not readable without membership.",
    "  - **Conversation frames — the transcript hydrates the client, so DO NOT build a hydration endpoint.**",
    "    - On a `conversation` channel the replay is PUSHED automatically at join, unasked: `conversation_start` (`payload.count`) → the last `limit` messages, each a normal `action: \"message\"` frame carrying its ORIGINAL `type` and `payload` plus `conversation: true` and the original `ts` → `conversation_end`.",
    "    - So the client needs NO fetch, no `GET /messages`, and no table read to paint the initial view. Render `message` frames identically either way; the backfill paints itself.",
    "    - ⚠ `{ enabled: true }` ALONE IS A NO-OP: `limit` defaults to 0, and 0 means RETAIN NONE (not retain everything), so the transcript is never written and never replayed, with no error. ALWAYS PASS `limit`.",
    "    - The POST-HANDLER broadcast payload IS the stored transcript row — a handler must broadcast everything the UI needs to render a past message (author name, id, `created_at`). Nothing else is replayed.",
    "    - Only `deliverTo` `\"channel\"`/`\"others\"` are RECORDED, so a `\"sender\"` response is invisible to every future joiner by construction.",
    "    - The transcript is a capped ring (`limit`, `ttl`), not storage. Persist to a table only for durability, search, or reads BEYOND that window — never merely to hydrate a joiner.",
    "  - **`delivery.guarantee: \"at_least_once\"` is a CLIENT CONTRACT, not just a channel setting.**",
    "    - The client must ACK what it receives — `{ action: \"ack\", channel, id }`, confirmed by `{ action: \"ack\", channel, payload: { cursor } }`.",
    "    - ⚠ An ANONYMOUS client must ALSO send a durable `options.client_id` in its JOIN frame (once; later acks need not repeat it). WITHOUT one it has no cursor, its acks are SILENTLY IGNORED, and it degrades to at_most_once. An AUTHENTICATED client is keyed by identity and needs no `client_id`.",
    "    - The missed gap arrives after join as `replay` frames, oldest-first, each with an `id` to ack.",
    "    - DISTINCT from the conversation transcript: `conversation_*` is the SHARED \"what was said before I arrived\", `replay` is the PER-CLIENT \"what I missed while disconnected\". Both may be on.",
    "    - How far back `replay` reaches is sized by `conversation.ttl` (here a REAL per-message age cut, and it BEATS `limit`), else `conversation.limit`, else 1000 — even on a channel with no transcript enabled.",
    "  - **What a message handler RETURNS decides delivery, and the failure directions are NOT symmetric.**",
    "    - A returned value fans out per `deliverTo` and becomes the transcript row.",
    "    - Returning NULL delivers NOTHING — the supported way to veto a message (the sender is told `dropped: true`).",
    "    - A payload REJECTED by the declared `input` also delivers nothing,; the detail goes ONLY to the sender.",
    "    - ⚠ But a handler that CRASHES FAILS OPEN: the sender's ORIGINAL, UNVALIDATED payload is broadcast to the channel unchanged. A handler doing redaction or authorization must NOT be the only thing between client input and subscribers.",
    "",
    "### Triggers",
    "",
    "**A trigger's `stack` is a callback — `stack: (t) => [...]`, not the plain",
    "`stack: []` array that `defineFunction`/`query`/`task` use.** That's the one",
    "shape that doesn't carry over from the other kinds: a trigger has no",
    "user-declared `input`, so its inputs are **implied by type** (fixed by Xano,",
    "not editable) and arrive through the typed **stack handle** `t` — you can't",
    "reference them without it. (Response-bearing types take `response: (t) =>",
    "ResponseDef` too.) `t` exposes exactly that trigger type's inputs; a wrong",
    "name is a compile error, not a runtime surprise. The seven trigger types are",
    "distinct root factories (not a namespace): `{tableTrigger, realtimeServerTrigger,",
    "realtimeChannelTrigger, mcpServerTrigger, agentTrigger, workspaceTrigger,",
    "errorTrigger}({ name, guid?, description?, active?, tags?, ... })`.",
    "",
    "- `tableTrigger({ name, table?, datasources?, actions?: {insert?,update?,delete?,truncate?}, stack })` — database/table trigger. `t.new` / `t.old` are the row **after** / **before** the change; `t.action` (`insert|update|delete|truncate`), `t.datasource`. Bind `table` to a `table()` handle and `t.new(\"col\")` / `t.old(\"col\")` are typed to that row (misspelled column = compile error). Nullability follows the enabled actions: insert → `old` is null, delete → `new` is null, update → both, truncate → neither. Config-only (no response).",
    "- `realtimeServerTrigger({ name, realtimeServer, actions?: {connect?,disconnect?}, stack?, response? })` — realtime SERVER lifecycle (a client connecting to / disconnecting from the server, not a message). Inputs: `t.action` (`connect|disconnect`), `t.realtime_server`, `t.client`. Bind `realtimeServer` to a `realtimeServer()` handle (or its name). `connect` GATES the connection — a denial sends an `error` and CLOSES the socket with code 4401 before it is ever ready, so it is a real front door, not an observer; same return shape as a channel `join` (`{ allowed: true }` or any truthy value admits, EMPTY/FALSY DENIES — INCLUDING a gating trigger with NO `response`, which returns nothing and so refuses every client). A CRASH is the OPPOSITE: gating actions fail OPEN, so a broken stack ADMITS; it is the clean-but-empty return that locks the door. `disconnect` is OBSERVATIONAL (return ignored, throws swallowed — cleanup must always complete). Both are SERVER-scoped, so `s.realtime.get_session` works but carries no channel path and no bound params.",
    "- `realtimeChannelTrigger({ name, channel, actions?: {join?,leave?,deliver?}, stack?, response? })` — realtime CHANNEL lifecycle. Inputs: `t.action` (`join|leave|deliver`), `t.channel`, `t.client`. Bind `channel` to a `realtimeChannel()` handle — a bare path is NOT accepted (it is unique only within its server). The three actions have DIFFERENT postures, and the posture decides what the stack should return: `join` GATES the join (it runs BEFORE the client becomes a member, so a denial means it never sees a fan-out) — return `{ allowed: true }` (optional `reason` reaches the client) or any truthy value to admit, and an EMPTY OR FALSY RETURN DENIES, so a stack that just falls through — or a gating trigger with NO `response` — refuses everyone (a CRASH is the opposite: gating actions fail OPEN and admit); `leave` is OBSERVATIONAL (return ignored, throws swallowed); `deliver` GATES delivery PER RECIPIENT — the per-viewer redaction tool and the most expensive action here (a stack per recipient per message), and it needs `delivery.perRecipient` on the channel to run at all. **`deliver`'s RETURN VALUES DO NOT READ LIKE A FILTER:** ONLY an explicit NULL drops the message for that recipient; an OBJECT replaces that recipient's payload; ANYTHING ELSE — INCLUDING `false`, `0`, `\"\"` — DELIVERS IT UNCHANGED, as does a crash. So `return false` from a yes/no redaction check SENDS the message it was written to suppress — return null instead. The delivered payload arrives NESTED, so read `inp(\"payload\").<field>`, and `t.client` is the SENDER while `s.realtime.get_session` describes the RECIPIENT this run is for.",
    "- `mcpServerTrigger(...)` / `agentTrigger({ name, objId, stack?, response? })` — toolset connection. Inputs: `t.toolset` (`t.toolset(\"name\")`), `t.tools`. Response-bearing; the default stack copies `toolset`/`tools` into vars and returns them.",
    "- `workspaceTrigger({ name, actions?: {branch_live?,branch_merge?,branch_new?}, stack? })` — branch lifecycle. Inputs: `t.to_branch`, `t.from_branch`, `t.action`. Config-only.",
    "- `errorTrigger({ name, stack? })` — error-signature trigger. Inputs: `t.event` (`new|regression|fixed`), `t.id`, `t.signature`, `t.error` (`t.error(\"code\")`/`t.error(\"message\")`), `t.caller`, `t.statement`, `t.actor`, `t.count`, `t.first_seen`, `t.last_seen`, `t.fixed_at`. Config-only.",
    "",
    "### Responses",
    "",
    "The `response?` field (on functions, queries, tools, middleware, and",
    "response-bearing triggers) maps to the stored `result[]`:",
    "",
    "- `ResponseDef = Value | Record<string, Value>`.",
    "- A single `Value` → one unnamed result item: `response: ref(\"rows\")`.",
    "- A record → one named item per key: `response: { user: ref(\"u\"), token: ref(\"t\") }`.",
    "- Omitted → empty `result[]` (no response body).",
    "",
    "### Expressions (`expr`)",
    "",
    "`expr(left, op, right)` builds the comparison used by every condition/`where`",
    "surface — `s.conditional`/`s.while` `when` (incl. each `elif` branch), and",
    "`db.query` `where`/`additionalWhere` (and the search triggers) — one shared tree.",
    "",
    "- `op`: `=`, `!=`, `>`, `<`, `>=`, `<=` (JS aliases `==` `===` `!==` are accepted and normalized).",
    "- `left`/`right` are `Value`s — `col(\"x\")` (a table column), `ref`, `inp`, `auth(...)`, or `c.*`.",
    "- For the full operator set (`in`/`like`/`ilike`/`between`/`contains`/`overlaps`/`@>`/`~`/`search`/…)",
    "  use `cmp(left, op, right, { ignoreEmpty? })`; compose nested boolean logic with `and(...)`/`or(...)`.",
    "- A condition/`where` accepts a single `expr(...)`/`cmp(...)`, an `and()`/`or()` group, an array of",
    "  those (ANDed), or (for `where`) a raw `Value`. `s.conditional`/`s.while`/`s.switch`, `db.query`,",
    "  `precondition`, and the `array.*` predicates all take the same shape.",
    "- ⚠ `mixed(a, { or: b }, { and: c })` reproduces a container whose terms do NOT all join the",
    "  same way — the editor allows it, so pulled workspaces contain it. **Do not author it.** The",
    "  stored form does not record the grouping, and the two places it can appear disagree: a",
    "  branch (`s.conditional`/`s.while`/`precondition`) folds terms strictly left to right, so",
    "  `a OR b AND c` is `(a OR b) AND c`, while a `db.query` filter applies the engine's",
    "  AND-before-OR precedence and selects `a OR (b AND c)`. Write `and(or(a, b), c)` or",
    "  `or(a, and(b, c))` — each says one reading in every context. Pulls report these as",
    "  `ambiguous-condition`.",
    "- A **filtered** operand (`withFilters(...)`) works inline in any condition/`where` (conditional,",
    "  while, `db.query`/addon, …) — e.g. `cmp(withFilters(col(\"title\"), fl.trim()), \"=\", inp(\"q\"))`.",
    '- e.g. `db.query({ table: posts, where: expr(col("author"), "=", auth("id")), as: "rows" })`.',
    "",
  );

  lines.push("## Values", "");
  for (const v of m.values.constructors) {
    if (v.legacy) continue;
    lines.push(`- \`${v.name}${v.signature}\` — ${v.description}`);
  }
  lines.push("", `Tags: ${m.values.tags.join(", ")}.`, "");

  lines.push("## Fields", "");
  lines.push(
    "Author table columns + function/API inputs with the typed catalog: `f.<type>(opts?)`",
    "for columns, `input.<type>(opts?)` for inputs. Common opts: `required`, `nullable`,",
    "`default`, `description`. `methods` is a bind-time validator/transform pipeline whose",
    "valid names depend on the field type (below) — pass bare names (`\"trim\"`), the",
    "colon-form with args (`\"min:8\"`), or `{ name, arg }` for anything not listed.",
    "`f.enum(values)`/`f.vector(size)`/`f.object(children)`/`f.tableRef(table)` take a",
    "positional payload before opts — and still accept the standard `FieldOptions` after it",
    "(`f.enum([])`/`input.enum([])` are accepted, because the engine stores an enum whose",
    "options were never filled in — that is a pulled-workspace shape, not one to author; it",
    "brands the column `never`.)",
    "(e.g. `f.tableRef(users, { required: true })`; `llms.txt` lists only tableRef's `min`/`max`",
    "methods, but `required`/`nullable`/`description`/… apply like any field).",
    "`{ array: true }` makes any `f.*` scalar a **list column** — `f.text({ array: true })`",
    "surfaces as `string[]` in `InferRow<typeof table>` (the column analogue of `input.list`).",
    "A **column `default` must stay within the BMP** — a 4-byte character (codepoint > U+FFFF,",
    "e.g. an emoji) is mangled into invalid UTF-8 by the engine's default pipeline and is rejected",
    "at export rather than 500ing at deploy (Postgres `22021`); BMP defaults (accents, `€`, most",
    "CJK) are fine, or put the value on an `input.<type>({ default })`, applied at runtime bind.",
    "`input.*` mirrors `f.*` — every column type below is",
    "a legal input (scalars, files `input.image/video/audio/attachment`, `input.geo.*`,",
    "`input.vector(size)`, `input.tableRef(table)`, `input.object(children)`), plus",
    "`input.dbLink(table)` is the odd one: ONE entry that EXPANDS into one input per",
    "COLUMN of the linked table, so read them by column name (`inp(\"email\")`), never by",
    "the entry's own name. `hidden: [\"created_at\"]` drops columns from that expansion.",
    "`input.list(element)` for arrays — wrap any element constructor, e.g.",
    "`input.list(input.text())` or `input.list(input.object({ id: f.int() }))`. Prefer the",
    "typed forms over `input.json()` when the shape is known.",
    "**Typed inputs validate/coerce on bind, before your stack runs** — so reach for the",
    "specific type instead of hand-rolling checks. `input.email({ required: true })` rejects a",
    "malformed address with a 400 (and trims; add `methods: [\"lower\"]` to downcase) — no",
    "`regex_matches` needed; `input.int`/`input.decimal`/`input.uuid`/`input.enum([...])`/`input.date`",
    "likewise reject or coerce bad input at the boundary. Drop to `input.text` + `s.precondition`",
    "only for rules no type expresses (see the boundary-validation recipe in the README).",
    "Normalizing transforms run on bind too — put `trim`/`lower`/`upper` on the input's `methods`",
    "so `inp(\"name\")` reads already-normalized; don't reroll `var $x = inp(\"name\")|trim` in the stack.",
    "",
  );
  for (const ft of m.fieldTypes) {
    const stored = ft.stored !== ft.name.replace(/^geo\./, "") ? ` (stored \`${ft.stored}\`)` : "";
    const methods = ft.methods.length ? ` — methods: ${ft.methods.join(", ")}` : "";
    // An input-only type has NO `f.` form; naming it `f.<name>` would document a
    // constructor that does not exist.
    const ns = ft.inputOnly ? "input" : "f";
    const only = ft.inputOnly ? " — INPUT ONLY (no `f.` form)" : "";
    lines.push(`- \`${ns}.${ft.name}\`${stored}${methods}${only}`);
  }
  lines.push("");

  lines.push("## Filters", "");
  lines.push(
    "Attach to a value with `withFilters(v, fl.name(...))` — the value `filters[]`",
    "pipeline. Filters are passed spread (canonical); the array form",
    "`withFilters(v, [fl.a(), fl.b()])` is also accepted. Typed filters carry named",
    "args; the rest are variadic by name.",
    "Read-modify-write a column from its current value with the pipeline: to increment",
    "a counter you MUST `db.get` the row first, then pipe its bound value —",
    "`col(\"clicks\")` does NOT resolve to the stored value inside a `db.edit` `row`",
    "(it is `null`, so `fl.add(1)` computes `null + 1` and the engine aborts):",
    "`s.db.get({ table, fieldValue, as: \"current\" })` then",
    "`s.db.edit({ table, fieldValue, row: { clicks: withFilters(ref(\"current.clicks\"), fl.add(c.int(1))) } })`.",
    "⚠ This read-modify-write is NOT atomic — two concurrent writers can both read the",
    "same value and one increment is lost. There is no dedicated atomic-increment",
    "statement, and one CANNOT be synthesized in the SDK (it would compile to this same",
    "`get` + `edit` pair). For a **concurrency-safe** counter, do the arithmetic in the",
    "database with a single `s.db.direct_query` UPDATE (`SET clicks = clicks + 1 WHERE …`),",
    "which the DB applies atomically. Reserve the pipeline form for low-contention counters",
    "where a rare lost update is acceptable.",
    "⚠ `direct_query` needs the table's PHYSICAL Postgres name, which the typed surface",
    "does NOT expose: the engine derives a physical name from workspace + table ids (of the",
    "form `x<workspace_id>_<table_id>`, e.g. `x6_203970`), ids assigned at import — not knowable",
    "from a `table()` def (identity is a name + guid, not the numeric id), and `sql_name`",
    "persists empty. So the safe counter drops out of the typed surface: hardcode",
    "the physical name after inspecting the deployed table. A typed atomic path needs an",
    "engine change.",
    "",
  );
  const typedFilters = m.filters.filter((fl) => fl.typed);
  for (const fl of typedFilters) {
    const sig = (fl.args ?? []).map((a) => `${a.name}${a.optional ? "?" : ""}: ${a.type}`).join(", ");
    const ret = fl.result ? `: ${fl.result}` : "";
    // Signature-first: render only a curated note (complete, non-truncated) where the
    // signature underspecifies; the raw source description is dropped from the primary
    // but retained in manifest.json. `hasOwn` guards against a filter name colliding with
    // an inherited Object member (e.g. "constructor").
    const note = Object.hasOwn(FILTER_NOTES, fl.name) ? FILTER_NOTES[fl.name] : undefined;
    lines.push(`- \`${fl.fl}(${sig})${ret}\`${note ? ` — ${note}` : ""}`);
  }
  const byName = m.filters.filter((fl) => !fl.typed).map((fl) => fl.name);
  lines.push("", `Other filters (reachable as \`fl.<name>\`, variadic): ${byName.join(", ")}.`, "");

  lines.push("## Statements", "");
  lines.push(
    "Reachable through the `s` namespace: `s.<path>({...})`. Declarative statements",
    "take one typed args object (field names match the engine) and their full field",
    "schema is listed per-namespace below. Specials (`[special]`) are hand-authored;",
    "their signatures are listed in **Specials — authored signatures** just below.",
    "Wrap any `value` field in `ignored(...)` to store it but SKIP it at runtime —",
    "  the engine records `<name>:ignore` and the parameter falls back to its default.",
    "  Not the same as an empty value, and not the same as omitting the field (which",
    "  stores no entry at all). Mostly seen on a pulled workspace.",
    "Fields marked `value` take a `Value` (`c.*`/`ref`/`inp`); `comparison` takes an",
    "`expr(...)`. A `→ as: <type>` suffix names what the statement's `as:` output var",
    "holds (curated, not exhaustive — absence means read the `[output]` flag and prose).",
    "",
  );

  // Curated signatures for the high-traffic specials — the ones whose args can't
  // be read off the per-namespace `(…)` listing. Authored from the arg
  // interfaces in `src/statements/special/` so an llms.txt-only agent can call
  // them without the .d.ts.
  lines.push(
    "### Specials — authored signatures",
    "",
    "Control flow & blocks (each nests a sub-stack; block specials name it `body`):",
    "",
    "- `s.set_var(name, value)` · `s.update_var(name, value)` · `s.return(value)` · `s.comment(text)` — positional.",
    "- **Every** statement takes `disabled?`/`description?` — annotations on the stack item, not args: `disabled: true` is Xano's \"disable step\" (kept in the stack, skipped at runtime), `description` the note beside it. Inline on object-arg factories; a trailing object on the positional ones (`s.set_var(\"x\", v, { disabled: true })`).",
    "- `s.conditional({ when, then, elif?, else? })` — if/elif/else. `when` is a condition (`expr`/`cmp`/`and`/`or`); `elif` is an ordered `[{ when, then }]` (each an else-if branch); `then`/`else` are `Statement[]`.",
    "- `s.for({ as, count, body })` — **count-bounded** loop (`as` is the index), NOT from/to.",
    "- `s.foreach({ as, list, body })` — iterate `list`; `as` is the current item.",
    "- `s.while({ when, body })` — `when` is a condition (`expr`/`cmp`/`and`/`or`).",
    "- `s.switch({ on, cases: [{ when, body, break? }], default? })` — multi-way branch on a subject `Value` `on`; each `case`'s `when` is a literal `Value` matched against `on` (NOT a comparison — use `s.conditional` for `<`/`>`/ranges); `break` stops fallthrough. Prefer over a long `elif` chain when matching one value against many literals.",
    "- `s.try_catch({ try, catch?, finally? })` — three `Statement[]` blocks.",
    "- `s.group(body)` / `s.util.post_process(body)` — take a `Statement[]` **positionally**.",
    "- `s.foreach_break()` / `s.foreach_continue()` / `s.foreach_remove()` — nullary loop control.",
    "- `s.expect.to_throw({ body, exception? })` — `body` is the statements expected to raise.",
    "",
    "Array blocks (an `if`/`transform` is applied per item):",
    "",
    "- `s.array.map({ source, as?, transform? })` — `transform` is a per-item `Value` expression.",
    "- `s.array.union({ source, with?, as?, transform? })` — set-union two arrays.",
    "",
    "DB reads/writes (`table` is a def handle or name; `fieldName` defaults to the",
    "primary key `id`):",
    "",
    "- `s.db.get({ table, fieldName?, fieldValue, lock?, output?, as? })` — one row by field match; `output` restricts returned columns (and overrides column visibility — it can pull `internal` columns like a password hash).",
    "- `s.db.has({ table, fieldName?, fieldValue, as? })` — existence test.",
    "- `s.db.del({ table, fieldName?, fieldValue, as? })` — delete by field match.",
    "- `s.db.add({ table, row?, data?, output?, as? })` — insert; `row` is a partial keyed by column.",
    "- `s.db.edit({ table, fieldName?, fieldValue, row?, data?, output?, as? })` — update by field match.",
    "- `s.db.patch({ table, fieldName?, fieldValue, data, output?, as? })` — merge a partial (`data` is an object value).",
    "  On these three, `output` restricts the columns of the RETURNED row only — it does not change",
    "  what is written. Not offered on `db.del`/`db.has` (their result is a scalar) or on",
    "  `db.add_or_edit` (no output envelope).",
    "- `s.db.add_or_edit({ table, fieldName?, fieldValue, row?, data?, as? })` — upsert.",
    "- `s.db.query({ table, where?, additionalWhere?, bind?, sort?, paging?, external?, returnType?, distinct?, eval?, output?, lock?, addon?, as? })` — search; `bind: [{ table, as?, join?, where? }]` adds joins (`context.bind[]`, `join` default `\"inner\"`) — joined columns are addressable by dotted path in `where`/`sort`/`eval`; `as` defaults to the table name and two joins to the same table need distinct aliases; `distinct` (`\"auto\"` default | `\"yes\"` | `\"no\"`) rides `context.return.<list|stream>.distinct`. `eval: [{ name, as, filters? }]` adds computed columns (`context.eval[]`) — each `as` grafts onto the row as an `unknown` key in `InferResponse` (shadowing a column throws); `returnType` (`\"list\"` default | `\"single\"` | `\"count\"` | `\"exists\"` | `\"stream\"` | `\"aggregate\"`) drives `context.return.type` and the `InferResponse` shape — `count`→`number`, `exists`→`boolean`, `single`→`Row|null`, `stream`→`Row[]` (pageable, no envelope), `list`→`Row[]`/envelope, `aggregate`→rows keyed by the `aggregate.group`/`eval` aliases. `aggregate: { group?, eval?, sort?, paging? }` (with `returnType:\"aggregate\"`) builds `context.return.aggregate` — `group`/`eval` are `{ name, as, filters? }` (an aggregator like `sum`/`count` rides `filters`); write each `name` as a **bare** column (`\"status\"`) — it is alias-qualified to `\"<table>.status\"` on emit (the engine rejects a bare column in an aggregate: `Unsupported param format`), and an already-dotted `name` (a `bind`ed/joined column) passes through; `where` is `expr(...)` / `expr[]` (ANDed) / raw `Value`. For the full operator set use `cmp(left, op, right, { ignoreEmpty? })` (`op`: `in`/`not in`/`like`/`ilike`/`between`/`contains`/`includes`/`overlaps`/`@>`/`~`/`search`/… plus the `expr` comparisons); compose nested boolean logic with `and(...)` / `or(...)` groups (also available on `addon()` `where`). A `where`/`cmp` operand may be a bare value (`col`/`inp`/`ref`/`auth`/`c.*`) OR a **filtered** value (`withFilters(...)`) inline — filtered operands pass through in every condition/`where` surface. Hoisting into a prior `s.set_var` is a readability/reuse option, not a requirement. `sort` is `[{ sortBy: <col>, dir?: \"asc\"|\"desc\"|\"rand\" }]`; `paging` is `{ page?, per_page?, offset?, totals?, metadata?, search?, sort? }`. `where`/`additionalWhere`/`sort`/`paging`/`output` are all applied by the engine — the filter rides `context.search`, sort/paging ride `context.return.list`. ⚠ Supplying `paging` with a page/per_page/offset field and metadata on (the default) wraps the result in a paging envelope `{ items: Row[], curPage, nextPage, prevPage, offset, perPage, itemsReceived }` (+ `itemsTotal`/`pageTotal` when `totals:true`) instead of a bare `Row[]`; `InferResponse` reflects that. Pass `metadata:false` to keep the bare array. **Input-bound paging:** `paging.page`/`per_page`/`offset` also accept a `Value` (e.g. `inp(\"page\")`) — it rides `context.simpleExternal` while the static block stays the engine gate (`enabled:true`); `paging.search`/`sort` are `Value` dynamic overrides. A `search`/`sort`-only `paging` (no numeric field) does NOT paginate. `external: { value, permissions? }` is the classic whole-config blob (forces the gate on); it falls back to input-bound `paging` when it resolves empty, so supplying both is valid. Read `nextPage` (`number|null`) as the typed has-next signal.",
    "- `s.db.truncate({ table, reset?, as? })` · `s.db.schema({ table, path, as? })`.",
    "- `s.db.direct_query({ sql, responseType?, args?, as? })` — `sql` is a **raw string** (not a `Value`); binds go in `args: Value[]`.",
    "- `s.db.transaction({ body })` — run a `Statement[]` atomically.",
    "- `s.db.bulk.add({ table, items, as? })` / `s.db.bulk.update` / `s.db.bulk.patch` — `items` is an array `Value`.",
    "- `s.db.bulk.delete({ table, where?, as? })` — deletes rows by a `context.search` filter. `where` is the same surface as `s.db.query` (`expr(...)`/`cmp(...)`, `and(...)`/`or(...)` groups, an array of those ANDed, or a raw `Value`) and encodes through the identical `{expression:[…]}` search shape. ⚠ Omitting `where` deletes **every** row.",
    "",
    "Runtime behavior (what the `as:` output holds, and misses):",
    "",
    "- `db.get` binds **`null`** when no row matches (it does NOT throw) — so the output is `InferRow<typeof table> | null`; null-check it. On a hit it binds the **full row**. (`db.has` is the boolean existence test.)",
    "- `db.edit` binds the **full, post-mutation row** (the freshly-written values, not the pre-edit ones). `db.add` binds the **full inserted row**, including the auto-assigned `id` and `created_at`. So `InferRow<typeof table>` is the right response type for those two. `db.del` **binds `null`** — the engine deletes the row and returns no value, so don't return the `as` var expecting the deleted row.",
    "- Unlike `db.get`, `db.edit` and `db.del` **throw** `NotFound` (HTTP 404) when no row matches the field. `db.add` throws on a unique-constraint violation.",
    "- **`InferResponse<typeof query>`** derives an endpoint's response type (read-side round trip, no codegen). It resolves object-literal responses to those keys, and a `response: ref(\"x\")` that returns a variable bound by a top-level db op on a `table()` to that op's result: the full row for `db.add`/`db.edit`/`db.patch`/`db.add_or_edit` (→ `Row` — each binds the full written row rather than null, so it stays non-nullable; a genuine miss throws instead of yielding null: `NotFound`/404 for `edit`/`patch`, a unique-constraint error for `add`, while `add_or_edit` upserts and never misses), `Row | null` for `db.get` (it binds `null` on a miss rather than throwing), a row list for `db.query`/`db.bulk.patch` (→ `Row[]`), a `boolean` for `db.has`, a `number` count for `db.bulk.delete`; a `get`/`query` `output: [...]` selection narrows to a `Pick` (still `| null` for `get`). A dotted `ref(\"row.col\")` into a `db.get` row projects the column carrying that `| null` (→ `Col | null`). A value reshaped by a filter/lambda, a variable built by control flow / `set_var` / a nested function, or an op the engine leaves untyped (`db.del`, `db.bulk.add`/`bulk.update`, raw `direct_query`), resolves to `unknown` — declare `responseShape` on the query (e.g. `responseShape: null as InferRow<typeof t> | null`) to close it; the declaration always overrides derivation. A `resultStrategy: \"replace\"` middleware attached `post` reshapes the endpoint's output at runtime, which the static walk can't see — declare `responseShape` when a post middleware rewrites the response.",
    "- **Addons** enrich returned rows: `db.query`/`get`/`add`/`edit`/`patch` accept `addon: [{ addon, as, input?, output?, children? }]`. `addon` is the target addon (name or def handle); `as` is the destination on the row — a bare alias (`\"_user\"`) or a dotted `offset.alias`, authored relative to a row (when the query returns a metadata paging envelope the `items[]` offset is prefixed automatically; writing it yourself is tolerated and not double-prefixed); `input` maps addon inputs (bind a parent-row column with `out(col)`); `output` restricts addon columns; `children` nests addons. An addon is a single table-bound db query (not a statement stack): author it with `addon({ name, table, tableAlias?, where?, sort?, output: [cols], cardinality?: \"single\"|\"list\"|\"count\"|\"exists\"|\"aggregate\", group?, eval?, input?, context? })` and register via `registerAddons([...])`: `table` auto-fills the `context.dbo` binding (⚠ never author `table: null` — a BROKEN table-less addon that returns nothing; `codegen` emits it only for a broken pulled object), `tableAlias` is its SQL alias (`context.dbo.as`), qualifying `where`/`sort` columns (`col(\"merchant.id\")`), `where`/`sort` (the same `expr(...)` / `[{ sortBy, dir }]` surface as `s.db.query`) encode `context.search`/`context.sort` — `where` is the predicate binding the addon to the parent row (e.g. `expr(col(\"id\"), \"=\", inp(\"user_id\"))`), `output` names the returned columns, and `cardinality` shapes the result (`context.return.type`, omitted for the `\"list\"` default). Rarer context (`eval`/`bind`/`lock`) stays raw `context` passthrough. When you attach a typed `addon({ table, output })` handle, its alias (the last `as` segment) is merged onto the row in `InferResponse` with the graft shape: `{cols}` for `single`, `{cols}[]` for `list`, `number` for `count`, `boolean` for `exists`, and for `aggregate` an array keyed by the `group`/`eval` aliases you pass (`unknown` values; `unknown` when neither is declared). An attachment-level `output` narrows an object/array graft further; a bare-name reference grafts `unknown` — narrow it at the call site. An alias that shadows an existing column on the queried table throws at build time (rename with a `_` prefix). `db.add_or_edit`/`del`/`has`/`truncate` take no `addon`.",
    "- **Middleware attachment** runs a reusable `middleware({...})` before/after a host's own stack. Attach with the host's `middleware: { pre, post }` field on `query`/`function`/`task`/`tool`/`apiGroup` (NOT triggers): each phase is an ordered list of middleware refs (def handle or name), or `{ middleware, active: false }` to keep an entry disabled. Providing a phase **overrides** it (sets the stored `pre_customize`/`post_customize` flag); omitting a phase **inherits** the parent tier's chain — the engine resolves Query → API Group → Workspace at request time (override, not merge; the API-Group tier applies to queries — functions/tasks/tools have no API-group binding and inherit straight from the workspace). Prefer a def handle over a bare name when the middleware pins an explicit `guid`. `pre: middleware.clear()` (an empty list) overrides with nothing — stop inheriting. Workspace-level defaults are the terminal tier: `workspaceConfig({ middleware: { query: { pre }, function, task, tool } })` emits the flat `{host}_{phase}` map (no `_customize` flags) — setting it replaces the whole workspace map, so unlisted hosts are cleared; omit the field to leave existing workspace middleware untouched. Distinct from `s.middleware.call` (inline invoke).",
    "- **Middleware request context.** A `pre` middleware runs **after** auth resolution, so `auth()` is available inside the middleware when the host is authenticated (its `auth` names an auth table); on a public host `auth()` is `null`. This matters for the canonical use — a rate limit keyed by `auth(\"id\")`: on an authenticated endpoint the bucket is per-user, but attach the same middleware to a public endpoint and every anonymous caller keys under the same `null` id (one shared bucket), silently. To catch that, `export()` **warns** (never blocks) when a middleware whose stack references `auth()` is directly attached to a host where `auth()` may be null — a `query` with no auth table, a `task` (scheduled, never authenticated), or a `function`/`tool` (whose auth is caller-dependent). An authenticated query (its own `auth` table set) is skipped. The check is direct-attachment only; a middleware reaching a public query via API-group/workspace tier inheritance is not caught.",
    "- **Rate-limit recipe (the canonical middleware).** Per-user rate limiting is the most common middleware. Author it with `s.redis.ratelimit` and a **composite key** built via the filter chain — `\"prefix\" + auth(\"id\")` does not exist, you build the key: `middleware({ name: \"write_rl\", exceptionPolicy: \"rethrow\", stack: [ s.redis.ratelimit({ key: withFilters(c.text(\"rl:write:\"), fl.concat(auth(\"id\"))), max: c.int(10), ttl: c.int(30), error: c.text(\"Too fast.\") }) ] })`. `exceptionPolicy: \"rethrow\"` is what makes a tripped limit abort with HTTP 429 (the default `\"silent\"` would let it through). Attach it with `middleware: { pre: [writeRl] }` on an **authenticated** host (its `auth` set) so `auth(\"id\")` keys per-user; on a public host `auth(\"id\")` is null and every caller shares one bucket (`export()` warns — see request context above). **Shared-bucket rule:** co-attaching one middleware object to N hosts means all N share the *same* key ⇒ *one* counter — `max: 10` is a global per-user budget across them, not 10-per-host. Vary the key (fold in the host/action name) for an independent limit per host.",
    "- **Middleware `exceptionPolicy`** governs what a **throw** in the middleware stack does to the request (SideStep passes the value through; the Xano engine interprets it). `\"silent\"` is the **default** — a throw is swallowed and the host continues as if the middleware succeeded, so a guard (rate limit, auth check) authored without an explicit policy is **not enforced** (the over-limit request goes through). `\"rethrow\"` aborts the request and surfaces the authored `error`/status (a tripped `s.redis.ratelimit` → HTTP 429); the `post` chain still runs — this is what a guard wants. `\"critical\"` behaves like `\"rethrow\"` (same aborted request, same HTTP status) but additionally **skips the entire `post` middleware chain**. The only difference between `rethrow` and `critical` is whether `post` runs — no status or logging change.",
    "",
    "- **Request history** controls per-object execution capture (the request/task/trigger debugger). Authored as a single scalar `history` field on any primitive: `false` off, `true` on at the default capture depth, a number = capture depth (how many statement executions are recorded per history record — NOT record retention), `\"all\"` unlimited. **Omit `history` to inherit** — the engine resolves object → container → workspace at request time (a query inherits from its API group, a tool from its toolset envelope, everything else straight from the workspace). Any authored value stops inheriting for that object. Per-kind defaults (when inheriting): query/task/tool capture ON, function/trigger/middleware OFF; default depth 100. Container tiers are authorable too — `apiGroup({ history })` sets the `query_*` default its queries inherit, and an agent/mcp_server/toolset `history` sets the `tool_*` default its tools inherit. Workspace-level defaults are the terminal tier: `workspaceConfig({ history: { query, function, task, tool, trigger, middleware } })` emits the flat `{objType}_enabled`/`{objType}_limit` map (no inherit flag) — setting it is wholesale (unlisted types fall back to their engine default), so declare every default you want to keep; omit the field to leave existing workspace history untouched.",
    "",
    "- **Workspace environment variables** set a tenant's env vars through the workspace object: `workspaceConfig({ env: { STRIPE_KEY: process.env.STRIPE_KEY!, APP_BASE_URL: \"https://…\" } })`. Author them as a name→value MAP. Read a var back with `env(\"NAME\")` (→ `$env.NAME`), which compiles to tag \"setting\" with the plain name. Values are SECRETS: prefer sourcing from `process.env` over committing literals, and don't commit a compiled bundle with real values. Deploy sets the declared vars on the tenant; omit `env` to leave existing env untouched. The separate `settings` field is a plain object.",
    "",
    "Auth & calls:",
    "",
    "- `s.security.create_auth_token({ table, id, extras?, expiration?, as? })` — `extras` defaults to `{}`, `expiration` to `86400`s (`0` = never).",
    "- `s.function.run({ fn, input?, as?, runtime? })` / `s.function.call({ fn, input?, as? })` — run another function; `input` is keyed by the target's input names.",
    "  - `runtime?` runs it in the BACKGROUND: `{ mode: \"async-shared\" }` or `{ mode: \"async-dedicated\", cpu?, memory?, timeout?, maxRetry? }` (resources read at dedicated only). An async call DOES NOT return the result — it dispatches and continues, so `as` binds nothing; collect with `s.await({ ids })`. Omit for a normal call. Same block on `s.ai.agent.run`.",
    "- `s.api.call({ api, input?, headers?, auth?, as? })` — invoke an endpoint; `auth` is `{ token, ignoreExpiration? }`.",
    "- `s.api.request({ url?, method?, params?, headers?, timeout?, follow_location?, verify_host?, verify_peer?, ca_certificate?, certificate?, certificate_pass?, private_key?, private_key_pass?, description?, output?, as? })` — external HTTP request (`mvp:api_request`). Ergonomic types, each also accepting a dynamic `Value`: `method` suggests the 7 verbs (GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH), `params` a plain JSON object **or** a record whose values are tagged `Value`s (`{ count: ref(\"count\") }`, each lifted via a `set` filter — the same record-of-values shape `response: { key: value }` takes) (→ query string for GET/HEAD/OPTIONS, body otherwise), `headers` a `string[]` of full header lines, `timeout` a `number` in seconds (1–86400), and `follow_location`/`verify_host`/`verify_peer` booleans. `description` (Settings tab) and `output` filters (Output tab) ride the envelope. SSL cert interdependencies (certificate↔private_key, ca_certificate→verify_peer) are checked at build time when statically provable, else by the engine at runtime. The `as` result is typed as the `{request, response}` envelope (`response.status: number`, `response.result: unknown`), so `InferResponse` resolves a `ref` to it. Same typed result on `webflow.request` and `api.microservice`.",
    "- `s.stream.from_request({ url?, method?, …tls, as? })` — streaming external HTTP request (`mvp:streaming_api_request`); same typed field surface as `s.api.request` (no description/output envelope).",
    "- `s.webflow.request({ path?, method?, …tls, as? })` — Webflow API request (`mvp:connect_webflow_api_request`); like `s.api.request` but addressed by `path` (host is engine-supplied).",
    "- `s.api.microservice({ host, path, method, params, headers, timeout, follow_location, as? })` — in-cluster microservice call (`mvp:microservice_request`); typed, all request fields required, no TLS fields.",
    "- `s.task.call` / `s.tool.call` / `s.trigger.call` / `s.middleware.call` / `s.addon.call` — same `{ <target>, input?, as? }` shape against the named kind.",
    "",
  );

  // Group by top-level namespace segment for readability. Legacy surfaces are
  // withheld here and named in the `## Legacy` index instead.
  const groups = new Map<string, ManifestStatement[]>();
  for (const s of m.statements) {
    if (s.legacy) continue;
    const ns = s.sPath.includes(".") ? s.sPath.slice(0, s.sPath.indexOf(".")) : "(top-level)";
    (groups.get(ns) ?? groups.set(ns, []).get(ns)!).push(s);
  }
  for (const ns of [...groups.keys()].sort()) {
    lines.push(`### ${ns}`, "");
    for (const s of groups.get(ns)!) {
      const call = `s.${s.sPath}`;
      const flags = [s.declarative ? null : "special", s.registered ? null : "unregistered", s.output ? "output" : null]
        .filter(Boolean)
        .join(", ");
      const flagSuffix = flags ? ` [${flags}]` : "";
      // Signature-first: the engine `storedName` is dropped (agents author `s.path`,
      // never `mvp:*`; it survives in manifest.json). Declarative statements keep the
      // field signature inline (defaults dropped except DEFAULT_KEEP); specials carry
      // no field schema in the listing — their real signature lives in the Specials
      // block / def-shapes / `.d.ts` — so they render as a terse discovery pointer.
      // The `as:` output binding, when curated — `→ as: <type> (<note>)`.
      const resultSuffix = s.result
        ? ` → ${s.result.name}: ${s.result.type}${s.result.note ? ` (${s.result.note})` : ""}`
        : "";
      if (s.fields) {
        const args = s.fields.map((f) => fieldLine(f, s.sPath)).join("; ");
        lines.push(`- \`${call}({ ${args} })\`${flagSuffix}${resultSuffix}`);
      } else {
        lines.push(`- \`${call}\`${flagSuffix}${resultSuffix}`);
      }
    }
    lines.push("");
  }

  // The legacy index: named, never specified. Everything here is supported and
  // still decodes out of a real workspace, so an agent reading pulled code has
  // to be able to recognize it — but nothing here should ever be chosen for new
  // code, so it carries no signature, no options, and no example to copy.
  //
  // Three surfaces feed it — values, statements, and trigger factories — because
  // a superseded paradigm does not confine itself to one layer of the SDK. The
  // realtime pair is the case that forced the generalization: the same paradigm
  // shows up as a trigger factory AND as a statement, and naming only one of them
  // leaves the other looking current.
  const legacyValues = m.values.constructors.filter((v) => v.legacy);
  const legacyStatements = m.statements.filter((s) => s.legacy);
  const legacyFactories = m.objectKinds.flatMap((k) => (k.subKinds ?? []).filter((sub) => sub.legacy));
  if (legacyValues.length + legacyStatements.length + legacyFactories.length + SUPERSEDED_STATEMENTS.size > 0) {
    lines.push(
      "## Legacy",
      "",
      "Older paradigms this SDK still supports and still emits when it decodes an existing",
      "workspace. **Do not author these.** They are listed by name only so you recognize them",
      "in pulled code rather than \"fixing\" them; each line names what to use instead.",
      "",
      "Names overlap across the split deliberately — the engine reused words like",
      "\"realtime\" and \"channel\" for both generations. A name matching is NOT evidence that",
      "two things are the same object; check which list it came from.",
      "",
    );
    for (const v of legacyValues) lines.push(`- \`${v.name}\` — ${v.description}`);
    for (const f of legacyFactories) lines.push(`- \`${f.authorFactory}()\` — ${f.description}`);
    for (const s of legacyStatements) {
      lines.push(`- \`s.${s.sPath}\` — ${LEGACY_SURFACES[s.surface]}`);
    }
    // Retired VERSIONS of versioned families. These have no `s.` surface at all —
    // only the latest of each family is authorable — so a pulled workspace holding
    // one shows it as `raw({ name: "<stored>", … })`. Named here for the same
    // reason as everything else in this index: an agent that has never heard of
    // one will try to "fix" what it does not recognize, and the fix would be
    // wrong, because each version was a breaking change to the one before it.
    const retired = [...SUPERSEDED_STATEMENTS.entries()];
    if (retired.length > 0) {
      lines.push("");
      lines.push(
        "Retired statement VERSIONS — no `s.` surface exists. Pulled code shows them as",
        "`raw({ name: \"…\" })` and they keep running as stored, so leave them; author the",
        "replacement only for NEW code. Never swap one for the other — each version broke the last.",
        "",
      );
      for (const [stored, successor] of retired) {
        lines.push(successor ? `- \`${stored}\` → \`${successor}\`` : `- \`${stored}\` — retired, no replacement`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
