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
export const TOTAL_OBJECT_KINDS = 24;

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
  /** Field schema — present for declarative statements. */
  fields?: ManifestField[];
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
}

/** A value constructor / helper. */
export interface ManifestValue {
  name: string;
  signature: string;
  description: string;
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
  /** The invocation verb, e.g. `sandbox deploy`. */
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
    command: "sandbox deploy",
    args: "<file> | --bundle <path>",
    flags: [
      { flag: "--reset", description: "Clear the sandbox workspace first for a full replace (default merges)." },
      { flag: "--static <dir>", description: "Archive a built frontend directory and deploy it to your workspace's static host (auto-deployed to dev) after the backend import. The backend URL is auto-injected into the build's root index.html as `window.XANO_HOST`, so the frontend needs no rebuild to target a sandbox." },
      { flag: "--static-host <name>", description: "Static-host NAME to deploy the frontend to (default `default`). Give each app a DISTINCT host so deploys don't share and overwrite the one `default` host — that shared host is why the first load after a deploy can serve a previous app's cached index.html. The host is auto-created on first deploy." },
      { flag: "--static-env KEY=VALUE", description: "Repeatable. Bake extra PUBLIC config into the static build's index.html as `window.<KEY>` globals (base URLs, publishable keys). Merged over the auto-seeded XANO_HOST; a static host serves these verbatim, so never put secrets here." },
      { flag: "--config <path>", description: "Project-local token cache (default: $XANO_CONFIG, then ./.xano/auth.json)." },
      { flag: "--global", description: "Read credentials from the shared ~/.sidestep/auth.json cache. Reads always try ./.xano/auth.json first, then fall back to the global cache." },
    ],
    description:
      "Deploy the compiled workspace to your sandbox (replaces the removed `push`), optionally with a static frontend. Prints a projected, secret-free summary as JSON on stdout (baseUrl + workspace id/name, plus the static URL when --static is used). The sandbox is the only deploy target. Never writes SERVER identities back into xano.lock (the compile step still maintains it exactly as `export` does).",
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
      "Export the workspace CURRENTLY DEPLOYED to your sandbox — as the JSON bundle (default) or the XanoScript multidoc (.xs). Both are pure OAuth meta calls against the sandbox: no local file, no compile step, so a bare `sandbox export` just works (run `sandbox deploy` first). To compile a LOCAL workspace to JSON instead, use `sidestep export <file>`. env/records/draft are unsupported (endpoint defaults).",
  },
  {
    command: "sandbox details",
    args: "[--config <path>] [--global]",
    description:
      "Print the sandbox tenant as JSON, headlined by its public `baseUrl` — read it to point a frontend at the deployed backend without re-running a deploy. Projects only safe fields (never the raw tenant blob).",
  },
  {
    command: "profile me",
    args: "[--config <path>] [--global]",
    description:
      "Print the scoped user and the instance base URL as JSON — read `instance` to configure a frontend's API base before a --static upload.",
  },
  {
    command: "login",
    args: "[--origin <origin>] [--config <path>] [--global] [--port <n>] [--scope <list>]",
    description: "OAuth sign-in (browser consent; pick the instance at consent). Caches tokens in ./.xano/auth.json, or in the shared ~/.sidestep/auth.json with --global. For CI, set $XANO_REFRESH_TOKEN + $XANO_CLIENT_ID instead.",
  },
  {
    command: "logout",
    args: "[--config <path>] [--global]",
    description: "Revoke the refresh token and delete the cached credentials (add --global to clear the shared ~/.sidestep cache).",
  },
  {
    command: "lock",
    args: "<rename|prune|adopt> …",
    description: "xano.lock identity maintenance (rename an object, prune stale entries, adopt an existing live bundle).",
  },
  {
    command: "version",
    args: "",
    description: "Print the installed @sidestep/core version to stdout (also `--version` / `-v`). Handy for debugging which build is running.",
  },
];

/**
 * The 12 implemented object kinds with their authoring + registration metadata.
 * `registered` is verified against the live kind registry at build time, and the
 * manifest test asserts payload keys match `registeredKinds()`. `mcp_server` and
 * `agent` are distinct kinds that both persist under the `toolset` payload key.
 */
const KIND_DESCRIPTORS: ReadonlyArray<Omit<ManifestKind, "registered">> = [
  { kind: "function", payloadKey: "function", authorFactory: "defineFunction", description: "Reusable server-side logic (a custom function) callable from any stack via `s.function.run`.", registerMethod: "registerFunctions" },
  { kind: "table", payloadKey: "dbo", authorFactory: "table", description: "A database table: typed columns (`f.*`), indexes, and views; the schema other kinds read and write.", registerMethod: "registerTables" },
  { kind: "query", payloadKey: "query", authorFactory: "query", description: "An HTTP API endpoint (verb + path) bound to an API group; the main request/response surface.", registerMethod: "registerQueries" },
  { kind: "api_group", payloadKey: "app", authorFactory: "apiGroup", description: "A container that groups queries under a shared base path, CORS, and swagger config.", registerMethod: "registerApiGroups" },
  {
    kind: "trigger",
    payloadKey: "trigger",
    authorFactory: "{tableTrigger,realtimeTrigger,mcpServerTrigger,agentTrigger,workspaceTrigger,errorTrigger}",
    description: "An event-driven handler fired by a DB write, realtime channel, MCP/agent connection, branch lifecycle, or error — inputs are implied by type and arrive on the `t` handle.",
    registerMethod: "registerTriggers",
    subKinds: [
      { authorFactory: "tableTrigger", objType: "database", description: "Fires when rows change on a bound table (insert/update/delete/truncate). The changed row is exposed as `t.new`/`t.old`, typed to the table when a `table()` handle is bound. Config-only (no response)." },
      { authorFactory: "realtimeTrigger", objType: "workspace_realtime_channel", description: "Fires on realtime channel activity (message/join); inspect the channel, connecting client, options, and payload via `t`. Response-bearing — defaults to echoing the payload." },
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
  { kind: "workspace", payloadKey: "workspace", authorFactory: "workspaceConfig", description: "Workspace-level configuration such as default middleware chains and request-history defaults per host kind.", registerMethod: "registerWorkspace" },
];

/** Value constructors / helpers exported from the package root. */
const VALUE_CONSTRUCTORS: ReadonlyArray<ManifestValue> = [
  { name: "c.text", signature: "(s: string) => Value", description: 'String constant → tag "const".' },
  { name: "c.int", signature: "(n: number) => Value", description: 'Integer constant → tag "const:int".' },
  { name: "c.decimal", signature: "(n: number) => Value", description: 'Decimal constant → tag "const:decimal".' },
  { name: "c.bool", signature: "(b: boolean) => Value", description: 'Boolean constant → tag "const:bool".' },
  { name: "c.null", signature: "() => Value", description: 'Null constant → tag "const:null".' },
  { name: "c.obj", signature: "(o: Json) => Value", description: 'Object constant (JSON string) → tag "const:obj". Plain JSON literals only — a nested tagged value (inp/ref/auth/c.*) is rejected; for a computed object response use a record of values, not c.obj (issue #42).' },
  { name: "c.array", signature: "(a: Json[]) => Value", description: 'Array constant (JSON string) → tag "const:array". Plain JSON literals only — a nested tagged value is rejected, same as c.obj (issue #42).' },
  { name: "c.now", signature: "() => Value", description: 'Current time as epoch-ms — the text("now") |to_epoch_ms chain (Xano has no $now setting, so it lives on c.* not sys). It is a FILTERED value, so it can\'t be an inline where/cmp operand (rejected at export, issue #118) — hoist it into an s.set_var and do cutoff math there (cutoff = now - max_age), then compare against the var (issue #120).' },
  { name: "obj", signature: "(fields: Record<string, Value | nested>) => Value", description: 'Dynamic object value → tag "const:expr2" (a XanoScript object-literal expression). The dynamic sibling of c.obj (issue #42): members may be inp/ref/auth/col/c.* values, nested records, or arrays. A value with filters, or a less-common tag (env/setting/output/…), is rejected. Use for e.g. s.ai.agent.run args.' },
  { name: "ref", signature: "(name: string, opts?: { safe?: boolean }) => Value", description: 'Reference a stack variable → tag "var". Pass { safe: true } for null-safe nested access — a dotted ref("owner.user_id", { safe: true }) compiles through the get filter so it resolves to null instead of raising "Unable to locate var" when the base is null (issue #47).' },
  { name: "inp", signature: "(name: string) => Value", description: 'Reference a function input → tag "input".' },
  { name: "col", signature: "(name: string) => Value", description: 'Reference a table column → tag "col".' },
  { name: "auth", signature: "(path?: string) => Value", description: 'Reference the authenticated identity (auth("id") → $auth.id) → tag "auth".' },
  { name: "env", signature: "(name: string) => Value", description: 'Reference a USER-DEFINED environment variable → tag "env". Not for built-in request/system vars — those are settings (see sys.*); env("remote_ip") reads a user var named remote_ip, not the caller IP.' },
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
const FIELD_DESCRIPTORS: ReadonlyArray<{ name: string; stored: string; methodKey?: string }> = [
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
  return FIELD_DESCRIPTORS.map(({ name, stored, methodKey }) => ({
    name,
    stored,
    methods: Object.keys(FIELD_METHODS[methodKey ?? name] ?? {}),
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
export const OVERRIDDEN_SURFACES = new Set([
  "mvp:api_request",
  "mvp:streaming_api_request",
  "mvp:connect_webflow_api_request",
  "mvp:microservice_request",
]);

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
  const objectKinds: ManifestKind[] = KIND_DESCRIPTORS.map((d) => ({
    ...d,
    registered: isRegisteredKind(d.kind),
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
    "## Deploy (backend + static frontend)",
    "",
    "Sidestep deploys your compiled workspace — and, in one command, your built",
    "static frontend — straight to Xano. Each `deploy` runs the same compile",
    "pipeline as `export` (honoring `xano.lock`), then POSTs the bundle.",
    "There is one deploy target plus a profile helper:",
    "",
    "- `sidestep sandbox deploy ./index.ts` — throwaway dev loop. POSTs to",
    "  `/api:meta/sandbox/bundle` (this REPLACES the removed `sidestep push`). The",
    "  bundle MERGES into the sandbox workspace by default; `--reset` clears it",
    "  first for a full replace. `--bundle <path>` uploads an already-exported",
    "  bundle instead of compiling an entry file. The sandbox is the ONLY deploy",
    "  target; there is no real-workspace deploy.",
    "  Nothing from the server is ever written back into `xano.lock` (the sandbox",
    "  is a separate ephemeral workspace, so its identities must not pollute it).",
    "  Deploying an ENTRY FILE does still update the local lock as a side effect of",
    "  the shared compile step — identically to `sidestep export`, and only when a",
    "  lock exists or `--lock` is passed. `--bundle <path>` skips compiling, so it",
    "  never touches the lock at all.",
    "- `sidestep sandbox export [--format <json|multidoc>]` — export the workspace",
    "  CURRENTLY DEPLOYED to your sandbox. Both formats are pure OAuth meta calls",
    "  against the sandbox — no local file, no compile step — so a bare",
    "  `sidestep sandbox export` just works (run `sandbox deploy` first). `--format`",
    "  defaults to `json`: it exports the deployed workspace as the JSON bundle (the",
    "  same packageExport shape `deploy` sends) by reading the tenant over the meta API",
    "  (the mechanism `sidestep validate` uses), NOT the local package. `--format",
    "  multidoc` writes the sandbox's XanoScript multidoc as a `.xs` file. To compile a",
    "  LOCAL workspace to JSON instead, use `sidestep export <file>`. Output defaults to",
    "  `./sandbox.<ext>`; `--name` overrides the basename, `--path` the location, and",
    "  `--path -` streams to stdout. env/records/draft are unsupported (endpoint defaults).",
    "- `sidestep sandbox details` — prints the sandbox tenant as JSON, headlined by",
    "  its public `baseUrl` (GET `/api:meta/sandbox/me`). An agent reads `baseUrl` to",
    "  point the frontend at the deployed backend WITHOUT re-running a deploy just to",
    "  recover the URL from the deploy response. Projects only safe fields.",
    "- `sidestep profile me` — prints the scoped user and (headline) the INSTANCE",
    "  BASE URL as JSON. That is the account ORIGIN, not the sandbox tenant — use",
    "  `sandbox details` for the sandbox's own base URL.",
    "",
    "**Static hosting — call this out to agents: it exists and is one flag.**",
    "`sidestep sandbox deploy ./index.ts --static ./dist` archives the built",
    "frontend directory (a dependency-free gzipped tarball, 100 MB cap) and deploys",
    "it to a static host AFTER the backend import. No separate frontend host to",
    "configure, no CI upload script — backend and static frontend ship together.",
    "Output highlights the two live URLs: `Backend deployed to sandbox <name>` with the",
    "`<baseUrl>` beneath, then `Static host deployed` with the `<url>` beneath",
    "(frontend). The frontend goes to your OWN (parent)",
    "workspace, NOT the sandbox — the sandbox tenant does not serve static hosting.",
    "The CLI resolves which workspace from your token (`auth/me`: the scoped workspace",
    "guid → its numeric id) and uploads to `/api:meta/workspace/{id}/static_host/default/build`,",
    "which auto-creates the host and auto-deploys to `dev`. The static step is",
    "independent and idempotent: a static failure never rolls back the backend — it",
    "exits with a distinct code and a resumable message, and you retry just the static",
    "step by re-running `sandbox deploy --static ./dist`.",
    "The deploy WIRES THE BACKEND URL IN FOR YOU: before archiving, it inserts an inline",
    "`<script>` at the top of the build's root index.html `<head>` that assigns the sandbox",
    "backend URL to `window.XANO_HOST` (seeded from the backend deploy's own response), running",
    "before the app bundle. So the frontend reads it at runtime with a build-time fallback and",
    "needs NO rebuild to target a sandbox — ideal for headless agents shipping a prebuilt ./dist:",
    "  const HOST = (typeof window !== 'undefined' && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST;",
    "Typical agent flow — build once, ship together:",
    "  1. `npm run build`                                (→ ./dist; no backend URL needed yet)",
    "  2. `sandbox deploy ./index.ts --static ./dist`    (ship API + app; XANO_HOST injected)",
    "Add your own PUBLIC config with `--static-env KEY=VALUE` (repeatable), exposed the same way",
    "as `window.<KEY>` and merged over the auto-seeded XANO_HOST. A static host serves these files",
    "verbatim, so everything injected is PUBLIC — base URLs and publishable keys only, never secrets",
    "(those go in backend env, read server-side via `env(name)`). Injection is skipped (a warning,",
    "not a failure) when the archive has no root index.html with a `<head>` to anchor to.",
    "`window.XANO_HOST` is the sandbox tenant URL the APIs answer at — the same value `sandbox details`",
    "prints as `baseUrl`, NOT `profile me` (the account instance origin). Prefer runtime injection; use",
    "`sandbox details` out of band only when you'd rather bake the URL in at build time instead.",
    "CACHING — the static host serves index.html with `Cache-Control: public, max-age=3600`, so after a",
    "deploy a browser or CDN can return the OLD html (a pre-injection copy with no XANO_HOST) for up to an",
    "hour. When an agent verifies the deploy, do NOT re-fetch the bare URL in a retry loop — it may keep",
    "reading the cached copy and appear to hang. Fetch once with a cache-busting query param and grep for",
    "the injected line: `curl -s \"$URL/?nocache=$EPOCH\" | grep XANO_HOST` (or hard-reload / disable cache",
    "in the browser). Absence of XANO_HOST on a plain reload is almost always this cache, not a failed",
    "injection — confirm against a cache-busted fetch before re-deploying.",
    "NOTE — the emitted line uses BRACKET notation: `window[\"XANO_HOST\"]=\"…\";` (that is how each",
    "`window.<KEY>` global is written). Grep for the bare token `XANO_HOST`, not the exact string",
    "`window.XANO_HOST` (dot form) — the dot form is valid to READ the global in your app, but it is",
    "not what the served index.html contains, so an exact-string grep for it wrongly reads as \"not injected\".",
    "",
    "Auth is OAuth: run `sidestep login` once (browser consent; you pick the",
    "instance at consent; tokens cached in project-local `.xano/auth.json`,",
    "auto-gitignored) — every `deploy` reuses and refreshes them. The target",
    "instance is always the one the token is bound to (its `aud`); there is no",
    "instance flag.",
    "AGENTS/CI: authenticate with `$XANO_REFRESH_TOKEN` + `$XANO_CLIENT_ID` +",
    "`deploy` (non-interactive refresh grant; both env vars come from",
    "`.xano/auth.json`; the instance is read from the token's `aud`) — do NOT run",
    "`sidestep login`, which blocks on a browser consent no agent can complete.",
    "Refresh tokens rotate on use (a stored one may be single-use);",
    "`XANO_NO_BROWSER=1` suppresses the browser spawn for headless login. Sign out",
    "with `sidestep logout` (revokes the refresh token, deletes the cache).",
    "NOTE — `sandbox deploy` writes to the user's sandbox tenant on a live instance,",
    "and `--reset` clears that sandbox workspace (objects AND records) before",
    "importing. The blast radius is the disposable sandbox, not a production",
    "workspace, but confirm with the user before the first run and before any",
    "`--reset`.",
    "NOTE — EVENT-DRIVEN OBJECTS DEPLOY BUT DO NOT FIRE IN THE SANDBOX. A `task`",
    "(scheduled), an `mcpServer`, and every trigger — `tableTrigger` included (an",
    "insert/update/delete on a bound table does NOT run its stack) — import cleanly",
    "but their stacks never execute in the sandbox, so an event-driven design",
    "(screen-on-insert, cron cleanup, MCP tool call) silently does nothing there and",
    "there is no way to manually fire one. VERIFY THE LOGIC OUT OF BAND: factor the",
    "body into a `defineFunction` (or a callable `query`) and invoke it directly —",
    "e.g. a `tableTrigger` that screens a row on insert should delegate to a function",
    "you can also call from a `query` via `s.function.run`, and you assert against",
    "that. Only synchronously-invoked objects (queries, functions, and the agents",
    "an endpoint calls with `s.ai.agent.run`) actually run in the sandbox.",
    "",
    "**Recommended style:** reach statements through the `s` namespace",
    "(`s.db.add`, `s.math.add`, …) — one discoverable, tab-completable surface. The",
    "flat factory aliases (`dbAdd`, `dbQuery`, `setVar`, `mathAdd`, …) are exported",
    "and identical in output; prefer `s.*` in new code so examples stay consistent.",
    "",
  );

  lines.push(
    "## Gotchas",
    "",
    "Where a cold reader's intuition usually diverges from this API:",
    "",
    "- **No callback builder.** It's flat def-objects + `register*`, not",
    "  `workspace(w => w.table(...))`. `workspace(name)` just returns a named",
    "  `new Xano()`; tables are `table({ schema: { col: f.text() } })`, not a",
    "  builder closure.",
    "- **Foreign key is `f.tableRef(table)`, not `ref`.** `ref(name)` references a",
    "  stack variable (a value); `f.tableRef` is the column constructor.",
    "- **Reference-helper picker:** `ref` = stack var (`as:` output), `inp` = input,",
    "  `col` = table column (in `db.query` `where`), `auth(\"id\")` = the caller,",
    "  `c.*` = a constant. Easy to mix up — pick by what you're pointing at.",
    "- **Drilling into a maybe-null `db.get` result 500s — use `ref(path, { safe: true })`.**",
    "  `db.get` binds `null` on a no-match, but a nested `ref(\"owner.user_id\")` resolves",
    "  `$owner.user_id` in one lookup and raises a runtime \"Unable to locate var\" (HTTP 500)",
    "  when `owner` is null — so an ownership/existence guard throws instead of failing",
    "  cleanly (issue #47). Either guard existence first (`expr(ref(\"owner\"), \"!=\", c.null())`,",
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
    "  every table (`system: true` by default) — declaring them by hand is redundant.",
    '  `id` is an `int` PK by default; pass `idType: "uuid"` on the table for a uuid key.',
    "  Both are valid targets wherever a column name is accepted — `db.query` `sort`/",
    "  `output`, a `db.get`/`edit`/`del` `fieldName`, etc. (the column-name type is",
    "  `keyof schema | \"id\" | \"created_at\"`), and both appear in `InferRow<typeof table>`.",
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
    "  is the just-put-it-on-disk one; `export()` returns the bundle object;",
    "  `emitBundle()` returns the pretty JSON string. The `node:fs` writers",
    "  (`writeBundle`/`writeArtifact`) and lock-file I/O import from `@sidestep/core/node`,",
    "  NOT the browser-safe `@sidestep/core` entry (which a frontend can import query",
    "  defs from to use `getPath()`/`InferInput` with no Node built-ins in the bundle).",
    "- **Client bundle size / tree-shaking.** `@sidestep/core` is `sideEffects: false`",
    "  and the `.` entry pulls no Node built-ins, so a bundler drops the SDK exports a",
    "  frontend doesn't use. But importing a query **def** for its `getPath()`/`verb`",
    "  also pulls whatever its `stack` references: the `s.*`/`c.*` factory CALLS run at",
    "  module load to BUILD the def, so they can't be tree-shaken away. Types are free",
    "  (`InferInput`/`InferRow` erase to nothing). To keep a client bundle minimal, put",
    "  route-facing metadata a frontend needs (the def handle for `getPath()`/`verb`, and",
    "  `type` imports) in a module separate from stack-heavy authoring, and `import type`",
    "  wherever you only need the shape.",
    "- **Intra-workspace imports use `.js` specifiers** (`../tables/links.js`), not",
    "  extensionless — the defs compile under `moduleResolution: bundler`. A cold start",
    "  often reaches for `../tables/links` first; add the `.js`.",
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
    "  typed `llm` block. Their `tools` take a `tool()` handle (or name), resolved to the",
    "  tool's guid like the call family; a raw numeric `id` is an escape hatch.",
    "- **`task.schedule` is an array** of `{ startsOn, freq?, repeatEnabled?, endsOn? }`",
    "  (`ScheduleDef[]`), not a single `{ type, value }`. `freq` is seconds; `startsOn`/",
    "  `endsOn` are **ISO-8601 string** timestamps (`\"2026-01-01T00:00:00Z\"`), not epoch",
    "  numbers (passing `0` is a type error).",
    "- **`get_input`/`get_raw_input` read the whole payload**, not one named input",
    "  (args are `{ as?, encoding?, excludeMiddleware? }` — no `name`). For a single",
    "  input use `inp(\"name\")`.",
    "- **Declare inputs with `input.<type>()`, read them with `inp(\"name\")`.** In an",
    "  `input: {}` block the columns are `input.text({...})` etc.; `inp` is the *value",
    "  ref* that reads an input inside the stack (`inp(\"name\")`). Writing `inp.text({...})`",
    "  in the input block is a compile error (`Property 'text' does not exist on type`",
    "  `'(name: string) => TaggedValue'`) — easy first mistake, caught at typecheck.",
    "- **Don't take a password through `input.password` on login — it double-hashes.**",
    "  An `f.password()` column hashes on write, and `input.password` *also* hashes the",
    "  submission on bind, so `s.security.check_password` compares two different hashes",
    "  and a correct password always fails (`ok:false` on a found row). Take the submitted",
    "  password as `input.text()` on both signup and login and pass the plaintext straight",
    "  to `check_password` (which does the comparison hash itself). This is a third-party",
    "  engine behavior (issue #109).",
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
    "- `apiGroup({ name, guid?, canonical?, description?, docs?, swagger?, apiGroupEnabled?, documentation?, cors? })` — a query container; register it and bind queries to it via their `apiGroup`.",
    "  - `cors?`: `{ mode?, allowOrigins?: string[], allowHeaders?: string[], allowCredentials?, maxAge?, allowMethods?: { get?, post?, put?, patch?, delete?, head? } }`.",
    "- `defineFunction`/`query`/`apiGroup` above cover the queries+tables core; the five below are the \"reach past that\" primitives (agents, tools, tasks, middleware, MCP servers). Same envelope conventions (`guid?`, `description?`, `docs?`, `tags?`, `history?`) unless noted.",
    "- `task({ name, guid?, description?, docs?, datasource?, active?, tags?, history?, schedule?, stack?, middleware? })` — a scheduled background job (function-like `stack`, no `input`/`response`).",
    "  - `schedule?`: a `ScheduleDef[]` (NOT a single object) — `{ startsOn, freq?, repeatEnabled?, endsOn? }`. `startsOn`/`endsOn` are **ISO-8601 string** timestamps (`\"2026-01-01T00:00:00Z\"`), not epoch numbers; `freq` is the repeat interval **in seconds** (default `86400` = daily); `endsOn` present ⇒ the schedule has an end. Deploys but does NOT fire in the sandbox (see the sandbox NOTE above).",
    "- `middleware({ name, guid?, description?, docs?, resultStrategy?, exceptionPolicy?, tags?, history?, input?, stack?, response? })` — a pre/post interceptor (function-like `stack`); attach it via a host's `middleware: { pre, post }`.",
    "  - `resultStrategy?`: `\"merge\" | \"replace\"` (default `merge`) — how the middleware `response` folds into the host's.",
    "  - `exceptionPolicy?`: `\"silent\" | \"rethrow\" | \"critical\"` (default `\"silent\"` — a throw is SWALLOWED, so a guard is NOT enforced). A rate-limit/auth guard wants `\"rethrow\"` (throw aborts the request, surfaces the status); `\"critical\"` also skips the `post` chain.",
    "- `tool({ name, guid?, description?, instructions?, docs?, enabled?, tags?, history?, input?, stack?, response?, middleware? })` — a function-like operation (`input`/`stack`/`response`) that a toolset (MCP server or agent) exposes. Register it, then reference it from a toolset's `tools`.",
    "- `mcpServer({ name, guid?, description?, instructions?, docs?, enabled?, canonical?, spec?, tags?, history?, tools? })` — an MCP toolset (no LLM). Returns a handle with `getPath()`/`getUrl(baseUrl)` for the Streamable-HTTP endpoint. Deploys but does NOT fire in the sandbox.",
    "  - `tools?`: a `ToolsetToolRef[]` — `{ tool: <a tool() handle or its name>, enabled?, auth? }` WRAPPERS, not bare handles. `auth` names an auth **table** (a `table({ auth: true })` handle or its name) — Xano's ONLY MCP auth surface (per-tool; there is no server-level gate).",
    "- `agent({ name, guid?, description?, docs?, enabled?, canonical?, tags?, history?, llm, tools?, output? })` — an LLM orchestrator. No top-level `instructions`/`prompt`/`spec` — the prompt lives under `llm`. Invoke from a stack with `s.ai.agent.run({ agent, args })`.",
    "  - `llm` (REQUIRED): typed provider settings, a discriminated union on `type` (`\"xano-free\" | \"anthropic\" | \"openai\" | \"google-genai\"`). Shared fields: `systemPrompt?`, `maxSteps?` (default `5`), and `prompt?` XOR `messages?`; plus provider fields (`apiKey?`, `model?`, `temperature?`, `reasoningEffort?`, …). String fields accept Twig placeholders — `{{ $args.x }}` for run inputs (the `args` of `s.ai.agent.run`), `{{ $env.NAME }}` for env vars.",
    "  - `tools?`: same `ToolsetToolRef[]` `{ tool, enabled?, auth? }` wrappers as `mcpServer`.",
    "  - `output?`: `{ schema: Record<string, input.*>, enabled? }` — structured-output schema. `schema` is a named-field record authored with the `input.*` catalog, exactly like a `defineFunction`/`query` `input:` map (the stored `structuredOutputsSchema` is the same wire shape as function inputs). e.g. `output: { schema: { priority: input.enum([\"low\",\"high\"]), summary: input.text() } }`. Byte-verified against a live-engine golden. When you pass the agent *handle* to `s.ai.agent.run({ agent })`, `.result` is typed straight from this schema — no `resultShape` witness needed (the shape is declared once). `resultShape` remains only to override that, or to type an agent referenced by bare name.",
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
    "name is a compile error, not a runtime surprise. The six trigger types are",
    "distinct root factories (not a namespace): `{tableTrigger, realtimeTrigger,",
    "mcpServerTrigger, agentTrigger, workspaceTrigger, errorTrigger}({ name, guid?,",
    "description?, active?, tags?, ... })`.",
    "",
    "- `tableTrigger({ name, table?, datasources?, actions?: {insert?,update?,delete?,truncate?}, stack })` — database/table trigger. `t.new` / `t.old` are the row **after** / **before** the change; `t.action` (`insert|update|delete|truncate`), `t.datasource`. Bind `table` to a `table()` handle and `t.new(\"col\")` / `t.old(\"col\")` are typed to that row (misspelled column = compile error). Nullability follows the enabled actions: insert → `old` is null, delete → `new` is null, update → both, truncate → neither. Config-only (no response).",
    "- `realtimeTrigger({ name, objId, actions?: {message?,join?}, stack?, response? })` — realtime channel. Inputs: `t.action` (`message|join`), `t.channel`, `t.client` (`t.client(\"permissions.dbo_id\")`), `t.options`, `t.payload`. Response-bearing; `response` defaults to the `payload` passthrough.",
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
    "`expr(left, op, right)` builds the comparison used by `s.conditional`/`s.while`",
    "`when`, and by `db.query` `where`/`additionalWhere` (and the search triggers).",
    "",
    "- `op`: `=`, `!=`, `>`, `<`, `>=`, `<=` (JS aliases `==` `===` `!==` are accepted and normalized).",
    "- `left`/`right` are `Value`s — `col(\"x\")` (a table column), `ref`, `inp`, `auth(...)`, or `c.*`.",
    "- `where` accepts a single `expr(...)`, an `expr[]` (ANDed together), or a raw `Value`.",
    '- e.g. `db.query({ table: posts, where: expr(col("author"), "=", auth("id")), as: "rows" })`.',
    "",
  );

  lines.push("## Values", "");
  for (const v of m.values.constructors) lines.push(`- \`${v.name}${v.signature}\` — ${v.description}`);
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
    "(e.g. `f.tableRef(users, { required: true })`; `llms.txt` lists only tableRef's `min`/`max`",
    "methods, but `required`/`nullable`/`description`/… apply like any field).",
    "`{ array: true }` makes any `f.*` scalar a **list column** — `f.text({ array: true })`",
    "surfaces as `string[]` in `InferRow<typeof table>` (the column analogue of `input.list`).",
    "A **column `default` must stay within the BMP** — a 4-byte character (codepoint > U+FFFF,",
    "e.g. an emoji) is mangled into invalid UTF-8 by the engine's default pipeline and is rejected",
    "at export rather than 500ing at deploy (Postgres `22021`); BMP defaults (accents, `€`, most",
    "CJK) are fine, or put the value on an `input.<type>({ default })`, applied at runtime bind. (issue #45)",
    "`input.*` fully mirrors `f.*` — every type below is",
    "a legal input (scalars, files `input.image/video/audio/attachment`, `input.geo.*`,",
    "`input.vector(size)`, `input.tableRef(table)`, `input.object(children)`), plus",
    "`input.list(element)` for arrays — wrap any element constructor, e.g.",
    "`input.list(input.text())` or `input.list(input.object({ id: f.int() }))`. Prefer the",
    "typed forms over `input.json()` when the shape is known.",
    "",
  );
  for (const ft of m.fieldTypes) {
    const stored = ft.stored !== ft.name.replace(/^geo\./, "") ? ` (stored \`${ft.stored}\`)` : "";
    const methods = ft.methods.length ? ` — methods: ${ft.methods.join(", ")}` : "";
    lines.push(`- \`f.${ft.name}\`${stored}${methods}`);
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
    "(it is `null`, so `fl.add(1)` computes `null + 1` and the engine aborts — issue #32):",
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
    "engine change (issue #35).",
    "",
  );
  const typedFilters = m.filters.filter((fl) => fl.typed);
  for (const fl of typedFilters) {
    const sig = (fl.args ?? []).map((a) => `${a.name}${a.optional ? "?" : ""}: ${a.type}`).join(", ");
    const ret = fl.result ? `: ${fl.result}` : "";
    // Signature-first: render only a curated note (complete, non-truncated) where the
    // signature underspecifies; the raw source description is dropped from the primary
    // but retained in manifest.json.
    const note = FILTER_NOTES[fl.name];
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
    "Fields marked `value` take a `Value` (`c.*`/`ref`/`inp`); `comparison` takes an",
    "`expr(...)`.",
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
    "- `s.conditional({ when, then, else? })` — `when` is `expr(...)`; `then`/`else` are `Statement[]`.",
    "- `s.for({ as, count, body })` — **count-bounded** loop (`as` is the index), NOT from/to.",
    "- `s.foreach({ as, list, body })` — iterate `list`; `as` is the current item.",
    "- `s.while({ when, body })` — `when` is `expr(...)`.",
    "- `s.switch({ on, cases: [{ when, body, break? }], default? })` — `on`/`when` are `Value`s.",
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
    "- `s.db.add({ table, row?, data?, as? })` — insert; `row` is a partial keyed by column.",
    "- `s.db.edit({ table, fieldName?, fieldValue, row?, data?, as? })` — update by field match.",
    "- `s.db.patch({ table, fieldName?, fieldValue, data, as? })` — merge a partial (`data` is an object value).",
    "- `s.db.add_or_edit({ table, fieldName?, fieldValue, row?, data?, as? })` — upsert.",
    "- `s.db.query({ table, where?, additionalWhere?, bind?, sort?, paging?, external?, returnType?, distinct?, eval?, output?, lock?, addon?, as? })` — search; `bind: [{ table, as?, join?, where? }]` adds joins (`context.bind[]`, `join` default `\"inner\"`) — joined columns are addressable by dotted path in `where`/`sort`/`eval`; `as` defaults to the table name and two joins to the same table need distinct aliases; `distinct` (`\"auto\"` default | `\"yes\"` | `\"no\"`) rides `context.return.<list|stream>.distinct`. `eval: [{ name, as, filters? }]` adds computed columns (`context.eval[]`) — each `as` grafts onto the row as an `unknown` key in `InferResponse` (shadowing a column throws); `returnType` (`\"list\"` default | `\"single\"` | `\"count\"` | `\"exists\"` | `\"stream\"` | `\"aggregate\"`) drives `context.return.type` and the `InferResponse` shape — `count`→`number`, `exists`→`boolean`, `single`→`Row|null`, `stream`→`Row[]` (pageable, no envelope), `list`→`Row[]`/envelope, `aggregate`→rows keyed by the `aggregate.group`/`eval` aliases. `aggregate: { group?, eval?, sort?, paging? }` (with `returnType:\"aggregate\"`) builds `context.return.aggregate` — `group`/`eval` are `{ name, as, filters? }` (an aggregator like `sum`/`count` rides `filters`); `where` is `expr(...)` / `expr[]` (ANDed) / raw `Value`. For the full operator set use `cmp(left, op, right, { ignoreEmpty? })` (`op`: `in`/`not in`/`like`/`ilike`/`between`/`contains`/`includes`/`overlaps`/`@>`/`~`/`search`/… plus the `expr` comparisons); compose nested boolean logic with `and(...)` / `or(...)` groups (also available on `addon()` `where`). A `where`/`cmp` operand must be a bare value (`col`/`inp`/`ref`/`auth`/`c.*`) — a **filtered** operand (`withFilters(...)` inline) is rejected at export (like `obj()`), since the engine can't resolve it inline and 500s at runtime; compute it in a prior `s.set_var` and reference the var. `sort` is `[{ sortBy: <col>, dir?: \"asc\"|\"desc\"|\"rand\" }]`; `paging` is `{ page?, per_page?, offset?, totals?, metadata?, search?, sort? }`. `where`/`additionalWhere`/`sort`/`paging`/`output` are all applied by the engine — the filter rides `context.search`, sort/paging ride `context.return.list` (#41/#34/#36). ⚠ Supplying `paging` with a page/per_page/offset field and metadata on (the default) wraps the result in a paging envelope `{ items: Row[], curPage, nextPage, prevPage, offset, perPage, itemsReceived }` (+ `itemsTotal`/`pageTotal` when `totals:true`) instead of a bare `Row[]`; `InferResponse` reflects that. Pass `metadata:false` to keep the bare array (#58). **Input-bound paging (#66):** `paging.page`/`per_page`/`offset` also accept a `Value` (e.g. `inp(\"page\")`) — it rides `context.simpleExternal` while the static block stays the engine gate (`enabled:true`); `paging.search`/`sort` are `Value` dynamic overrides. A `search`/`sort`-only `paging` (no numeric field) does NOT paginate. `external: { value, permissions? }` is the classic whole-config blob (mutually exclusive with input-bound `paging` fields; forces the gate on). Read `nextPage` (`number|null`) as the typed has-next signal.",
    "- `s.db.truncate({ table, reset?, as? })` · `s.db.schema({ table, path, as? })`.",
    "- `s.db.direct_query({ sql, responseType?, args?, as? })` — `sql` is a **raw string** (not a `Value`); binds go in `args: Value[]`.",
    "- `s.db.transaction({ body })` — run a `Statement[]` atomically.",
    "- `s.db.bulk.add({ table, items, as? })` / `s.db.bulk.update` / `s.db.bulk.patch` — `items` is an array `Value`.",
    "- `s.db.bulk.delete({ table, where?, as? })` — deletes rows by a `context.search` filter. `where` is the same surface as `s.db.query` (`expr(...)`/`cmp(...)`, `and(...)`/`or(...)` groups, an array of those ANDed, or a raw `Value`) and encodes through the identical `{expression:[…]}` search shape. ⚠ Omitting `where` deletes **every** row; the `context.search` bytes are grounded in the `dbo_view` search reader but not yet byte-verified against a captured golden.",
    "",
    "Runtime behavior (what the `as:` output holds, and misses):",
    "",
    "- `db.get` binds **`null`** when no row matches (it does NOT throw) — so the output is `InferRow<typeof table> | null`; null-check it. On a hit it binds the **full row**. (`db.has` is the boolean existence test.)",
    "- `db.edit` binds the **full, post-mutation row** (the freshly-written values, not the pre-edit ones). `db.add` binds the **full inserted row**, including the auto-assigned `id` and `created_at`. So `InferRow<typeof table>` is the right response type for those two. `db.del` **binds `null`** — the engine deletes the row and returns no value, so don't return the `as` var expecting the deleted row.",
    "- Unlike `db.get`, `db.edit` and `db.del` **throw** `NotFound` (HTTP 404) when no row matches the field. `db.add` throws on a unique-constraint violation.",
    "- **`InferResponse<typeof query>`** derives an endpoint's response type (read-side round trip, no codegen). It resolves object-literal responses to those keys, and a `response: ref(\"x\")` that returns a variable bound by a top-level db op on a `table()` to that op's result: the full row for `db.add`/`db.edit`/`db.patch`/`db.add_or_edit` (→ `Row` — each binds the full written row rather than null, so it stays non-nullable; a genuine miss throws instead of yielding null: `NotFound`/404 for `edit`/`patch`, a unique-constraint error for `add`, while `add_or_edit` upserts and never misses), `Row | null` for `db.get` (it binds `null` on a miss rather than throwing, #105), a row list for `db.query`/`db.bulk.patch` (→ `Row[]`), a `boolean` for `db.has`, a `number` count for `db.bulk.delete`; a `get`/`query` `output: [...]` selection narrows to a `Pick` (still `| null` for `get`). A dotted `ref(\"row.col\")` into a `db.get` row projects the column carrying that `| null` (→ `Col | null`). A value reshaped by a filter/lambda, a variable built by control flow / `set_var` / a nested function, or an op the engine leaves untyped (`db.del`, `db.bulk.add`/`bulk.update`, raw `direct_query`), resolves to `unknown` — declare `responseShape` on the query (e.g. `responseShape: null as InferRow<typeof t> | null`) to close it; the declaration always overrides derivation. A `resultStrategy: \"replace\"` middleware attached `post` reshapes the endpoint's output at runtime, which the static walk can't see — declare `responseShape` when a post middleware rewrites the response.",
    "- **Addons** enrich returned rows: `db.query`/`get`/`add`/`edit`/`patch` accept `addon: [{ addon, as, input?, output?, children? }]`. `addon` is the target addon (name or def handle); `as` is the destination on the row — a bare alias (`\"_user\"`) or a dotted `offset.alias`, authored relative to a row (when the query returns a metadata paging envelope the `items[]` offset is prefixed automatically; writing it yourself is tolerated and not double-prefixed); `input` maps addon inputs (bind a parent-row column with `out(col)`); `output` restricts addon columns; `children` nests addons. An addon is a single table-bound db query (not a statement stack): author it with `addon({ name, table, where?, sort?, output: [cols], cardinality?: \"single\"|\"list\"|\"count\"|\"exists\"|\"aggregate\", group?, eval?, input?, context? })` and register via `registerAddons([...])`: `table` auto-fills the `context.dbo` binding, `where`/`sort` (the same `expr(...)` / `[{ sortBy, dir }]` surface as `s.db.query`) encode `context.search`/`context.sort` — `where` is the predicate binding the addon to the parent row (e.g. `expr(col(\"id\"), \"=\", inp(\"user_id\"))`), `output` names the returned columns, and `cardinality` shapes the result (`context.return.type`, omitted for the `\"list\"` default). Rarer context (`eval`/`bind`/`lock`) stays raw `context` passthrough. When you attach a typed `addon({ table, output })` handle, its alias (the last `as` segment) is merged onto the row in `InferResponse` with the graft shape: `{cols}` for `single`, `{cols}[]` for `list`, `number` for `count`, `boolean` for `exists`, and for `aggregate` an array keyed by the `group`/`eval` aliases you pass (`unknown` values; `unknown` when neither is declared). An attachment-level `output` narrows an object/array graft further; a bare-name reference grafts `unknown` — narrow it at the call site. An alias that shadows an existing column on the queried table throws at build time (rename with a `_` prefix). `db.add_or_edit`/`del`/`has`/`truncate` take no `addon`.",
    "- **Middleware attachment** runs a reusable `middleware({...})` before/after a host's own stack. Attach with the host's `middleware: { pre, post }` field on `query`/`function`/`task`/`tool`/`apiGroup` (NOT triggers): each phase is an ordered list of middleware refs (def handle or name), or `{ middleware, active: false }` to keep an entry disabled. Providing a phase **overrides** it (sets the stored `pre_customize`/`post_customize` flag); omitting a phase **inherits** the parent tier's chain — the engine resolves Query → API Group → Workspace at request time (override, not merge; the API-Group tier applies to queries — functions/tasks/tools have no API-group binding and inherit straight from the workspace). Prefer a def handle over a bare name when the middleware pins an explicit `guid`. `pre: middleware.clear()` (an empty list) overrides with nothing — stop inheriting. Workspace-level defaults are the terminal tier: `workspaceConfig({ middleware: { query: { pre }, function, task, tool } })` emits the flat `{host}_{phase}` map (no `_customize` flags) — setting it replaces the whole workspace map, so unlisted hosts are cleared; omit the field to leave existing workspace middleware untouched. SideStep emits the per-tier lists + flags only; it does not compute the fallback. Distinct from `s.middleware.call` (inline invoke).",
    "- **Middleware request context.** A `pre` middleware runs **after** auth resolution, so `auth()` is available inside the middleware when the host is authenticated (its `auth` names an auth table); on a public host `auth()` is `null`. This matters for the canonical use — a rate limit keyed by `auth(\"id\")`: on an authenticated endpoint the bucket is per-user, but attach the same middleware to a public endpoint and every anonymous caller keys under the same `null` id (one shared bucket), silently. To catch that, `export()` **warns** (never blocks) when a middleware whose stack references `auth()` is directly attached to a host where `auth()` may be null — a `query` with no auth table, a `task` (scheduled, never authenticated), or a `function`/`tool` (whose auth is caller-dependent). An authenticated query (its own `auth` table set) is skipped. The check is direct-attachment only; a middleware reaching a public query via API-group/workspace tier inheritance is not caught.",
    "- **Rate-limit recipe (the canonical middleware).** Per-user rate limiting is the most common middleware. Author it with `s.redis.ratelimit` and a **composite key** built via the filter chain — `\"prefix\" + auth(\"id\")` does not exist, you build the key: `middleware({ name: \"write_rl\", exceptionPolicy: \"rethrow\", stack: [ s.redis.ratelimit({ key: withFilters(c.text(\"rl:write:\"), fl.concat(auth(\"id\"))), max: c.int(10), ttl: c.int(30), error: c.text(\"Too fast.\") }) ] })`. `exceptionPolicy: \"rethrow\"` is what makes a tripped limit abort with HTTP 429 (the default `\"silent\"` would let it through). Attach it with `middleware: { pre: [writeRl] }` on an **authenticated** host (its `auth` set) so `auth(\"id\")` keys per-user; on a public host `auth(\"id\")` is null and every caller shares one bucket (`export()` warns — see request context above). **Shared-bucket rule:** co-attaching one middleware object to N hosts means all N share the *same* key ⇒ *one* counter — `max: 10` is a global per-user budget across them, not 10-per-host. Vary the key (fold in the host/action name) for an independent limit per host.",
    "- **Middleware `exceptionPolicy`** governs what a **throw** in the middleware stack does to the request (SideStep passes the value through; the Xano engine interprets it). `\"silent\"` is the **default** — a throw is swallowed and the host continues as if the middleware succeeded, so a guard (rate limit, auth check) authored without an explicit policy is **not enforced** (the over-limit request goes through). `\"rethrow\"` aborts the request and surfaces the authored `error`/status (a tripped `s.redis.ratelimit` → HTTP 429); the `post` chain still runs — this is what a guard wants. `\"critical\"` behaves like `\"rethrow\"` (same aborted request, same HTTP status) but additionally **skips the entire `post` middleware chain**. The only difference between `rethrow` and `critical` is whether `post` runs — no status or logging change.",
    "",
    "- **Request history** controls per-object execution capture (the request/task/trigger debugger). Authored as a single scalar `history` field on any primitive: `false` off, `true` on at the default capture depth, a number = capture depth (how many statement executions are recorded per history record — NOT record retention), `\"all\"` unlimited. **Omit `history` to inherit** — the engine resolves object → container → workspace at request time (a query inherits from its API group, a tool from its toolset envelope, everything else straight from the workspace). Any authored value stops inheriting for that object. Per-kind defaults (when inheriting): query/task/tool capture ON, function/trigger/middleware OFF; default depth 100. Container tiers are authorable too — `apiGroup({ history })` sets the `query_*` default its queries inherit, and an agent/mcp_server/toolset `history` sets the `tool_*` default its tools inherit. Workspace-level defaults are the terminal tier: `workspaceConfig({ history: { query, function, task, tool, trigger, middleware } })` emits the flat `{objType}_enabled`/`{objType}_limit` map (no inherit flag) — setting it is wholesale (unlisted types fall back to their engine default), so declare every default you want to keep; omit the field to leave existing workspace history untouched. SideStep emits the per-tier stored values + the inherit flag only; it does not compute the fallback.",
    "",
    "Auth & calls:",
    "",
    "- `s.security.create_auth_token({ table, id, extras?, expiration?, as? })` — `extras` defaults to `{}`, `expiration` to `86400`s (`0` = never).",
    "- `s.function.run({ fn, input?, as? })` / `s.function.call({ fn, input?, as? })` — run another function; `input` is keyed by the target's input names.",
    "- `s.api.call({ api, input?, headers?, auth?, as? })` — invoke an endpoint; `auth` is `{ token, ignoreExpiration? }`.",
    "- `s.api.request({ url?, method?, params?, headers?, timeout?, follow_location?, verify_host?, verify_peer?, ca_certificate?, certificate?, certificate_pass?, private_key?, private_key_pass?, description?, output?, as? })` — external HTTP request (`mvp:api_request`). Ergonomic types, each also accepting a dynamic `Value`: `method` suggests the 7 verbs (GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH), `params` a plain JSON object **or** a record whose values are tagged `Value`s (`{ count: ref(\"count\") }`, each lifted via a `set` filter — the same record-of-values shape `response: { key: value }` takes) (→ query string for GET/HEAD/OPTIONS, body otherwise), `headers` a `string[]` of full header lines, `timeout` a `number` in seconds (1–86400), and `follow_location`/`verify_host`/`verify_peer` booleans. `description` (Settings tab) and `output` filters (Output tab) ride the envelope. SSL cert interdependencies (certificate↔private_key, ca_certificate→verify_peer) are checked at build time when statically provable, else by the engine at runtime. The `as` result is typed as the `{request, response}` envelope (`response.status: number`, `response.result: unknown`), so `InferResponse` resolves a `ref` to it. Same typed result on `webflow.request` and `api.microservice`.",
    "- `s.stream.from_request({ url?, method?, …tls, as? })` — streaming external HTTP request (`mvp:streaming_api_request`); same typed field surface as `s.api.request` (no description/output envelope).",
    "- `s.webflow.request({ path?, method?, …tls, as? })` — Webflow API request (`mvp:connect_webflow_api_request`); like `s.api.request` but addressed by `path` (host is engine-supplied).",
    "- `s.api.microservice({ host, path, method, params, headers, timeout, follow_location, as? })` — in-cluster microservice call (`mvp:microservice_request`); typed, all request fields required, no TLS fields.",
    "- `s.task.call` / `s.tool.call` / `s.trigger.call` / `s.middleware.call` / `s.addon.call` — same `{ <target>, input?, as? }` shape against the named kind.",
    "",
  );

  // Group by top-level namespace segment for readability.
  const groups = new Map<string, ManifestStatement[]>();
  for (const s of m.statements) {
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
      if (s.fields) {
        const args = s.fields.map((f) => fieldLine(f, s.sPath)).join("; ");
        lines.push(`- \`${call}({ ${args} })\`${flagSuffix}`);
      } else {
        lines.push(`- \`${call}\`${flagSuffix}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
