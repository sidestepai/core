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
import { DECODE_ONLY_STATEMENTS } from "../statements/decode-only.js";
import type { StatementSpec } from "../statements/schema-dsl/interpret.js";
import {
  STATEMENT_SURFACES,
  TOTAL_STATEMENTS,
  sPathOf,
} from "../statements/surfaces.js";
import { isRegisteredStatement } from "../statements/statement.js";
import { isRegisteredKind } from "../kinds/kind.js";
import { TAGS } from "../types/xdo.js";
import { LAMBDA_BINDINGS, LAMBDA_GLOBALS, LAMBDA_MODULE_GLOBALS } from "../values/lambda.js";
import type { LambdaSurface } from "../values/lambda.js";
import { FILTER_NAMES, FILTER_SPECS } from "../values/generated/filters.generated.js";
import { FIELD_METHODS } from "../fields/generated/field-methods.generated.js";
import { COMMANDS, FLAGS, flagKey, flagSummary } from "../emit/commands.js";
import type { CommandSpec, SubcommandSpec, FlagRef } from "../emit/commands.js";

/**
 * One entry in the engine's object-kind catalog — the coverage DENOMINATOR,
 * enumerated rather than asserted as a bare number.
 *
 * The engine counts each trigger TYPE as its own object kind, while this SDK
 * models them as sub-kinds of a single `trigger` kind. A count of registered SDK
 * kinds therefore understated coverage by seven, which is why the denominator is
 * a named list now: the number is derived from entries that each say which
 * factory authors them, and an unmapped entry has to explain itself.
 */
export interface EngineObjectKind {
  /** Engine object-kind name. */
  kind: string;
  /**
   * The SDK factory that authors it, or `null` when this SDK models no kind for
   * it. Pinned in both directions against {@link KIND_DESCRIPTORS} (including
   * sub-kind factories), so neither table can drift from the other.
   */
  authorFactory: string | null;
  /** Why an unmapped kind is absent. Required exactly when `authorFactory` is null. */
  absence?: string;
}

/** A statement field, flattened from its generated spec rule. */
export interface ManifestField {
  name: string;
  /** `string` (a plain string arg), `value` (a tagged `Value`), or `comparison`. */
  type: StatementSpec["rules"][number]["type"];
  optional: boolean;
  default?: string;
  /**
   * The field's closed set of legal values, where the engine declares one. Both
   * a bare literal and the `c.text(...)` spelling are accepted, and a constant
   * outside the set is rejected at authoring time.
   */
  enum?: string[];
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
  /**
   * Named, typed args (richly-specified filters only). `enum` carries the exact
   * accepted spellings where the arg has a closed set — printed in place of the
   * bare word "enum", which told a reader nothing (#198).
   */
  args?: Array<{ name: string; type: string; optional?: boolean; enum?: string[] }>;
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
 * One CLI command, DERIVED from the `COMMANDS`/`FLAGS` registry in
 * `src/emit/commands.ts` — the same table that renders `--help` and generates the
 * shell completions.
 *
 * It used to be hand-maintained here, and it drifted: `init` and `validate` were
 * missing outright, `deploy` was short six flags, and the `--static` description
 * claimed the frontend always lands on the parent workspace (true only under
 * `--dest sandbox`). Deriving it makes that class of drift unrepresentable, which
 * matters more now that `llms.txt` no longer documents the CLI — this array and
 * `--help` are the only two surfaces, and they are now one source.
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
    /**
     * Counted over the ENGINE's object-kind catalog, where every trigger type is
     * its own kind. `unmodeled` names the shortfall so the denominator is
     * inspectable rather than a bare ratio.
     */
    objectKinds: {
      implemented: number;
      total: number;
      unmodeled: { kind: string; absence: string }[];
    };
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
/** `[{name, required}]` → the usage grammar string, e.g. `<file> [dir]`. */
function argGrammar(args: readonly { name: string; required: boolean }[] | undefined): string | undefined {
  if (args === undefined || args.length === 0) return undefined;
  return args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

/** A command's flag refs → the manifest's `{flag, description}` pairs. */
function flagsOf(refs: readonly FlagRef[] | undefined): ManifestCliFlag[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  return refs.map((ref) => ({ flag: FLAGS[flagKey(ref) as keyof typeof FLAGS].spec, description: flagSummary(ref) }));
}

/**
 * Flatten the registry into one manifest entry per invocable verb. A command with
 * subcommands contributes one entry per subcommand (`ephemeral get`) rather than a
 * single `ephemeral list|get|delete` row, so grepping the manifest for the verb an
 * agent means to run actually finds it. Removed verbs are omitted — they exist in
 * the registry only to fail loudly with an explanation.
 */
function buildCli(): ManifestCliCommand[] {
  const out: ManifestCliCommand[] = [];
  for (const [name, spec] of Object.entries(COMMANDS) as [string, CommandSpec][]) {
    if (spec.removed !== undefined) continue;
    const description =
      spec.aliasOf === undefined ? spec.summary : `${spec.summary} (alias of \`${spec.aliasOf}\`)`;
    const subs = Object.entries(spec.subcommands ?? {}) as [string, SubcommandSpec][];
    if (subs.length === 0) {
      out.push({
        command: name,
        ...(argGrammar(spec.args) !== undefined ? { args: argGrammar(spec.args)! } : {}),
        ...(flagsOf(spec.flags) !== undefined ? { flags: flagsOf(spec.flags)! } : {}),
        description,
      });
      continue;
    }
    for (const [subName, sub] of subs) {
      if (sub.removed !== undefined) continue;
      const args = argGrammar(sub.args ?? spec.args);
      const flags = flagsOf(sub.flags ?? spec.flags);
      out.push({
        command: `${name} ${subName}`,
        ...(args !== undefined ? { args } : {}),
        ...(flags !== undefined ? { flags } : {}),
        description: sub.summary,
      });
    }
  }
  return out.sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * The implemented object kinds with their authoring + registration metadata.
 * `registered` is verified against the live kind registry at build time, and the
 * manifest test asserts payload keys match `registeredKinds()`. `mcp_server` and
 * `agent` are distinct kinds that both persist under the `toolset` payload key.
 *
 * These are SIDESTEP kinds, which are not one-to-one with the engine's object
 * kinds — `trigger` covers seven of them. {@link ENGINE_OBJECT_KINDS} holds that
 * mapping, and is what coverage counts against.
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
  { kind: "workflow_test", payloadKey: "workflow_test", authorFactory: "workflowTest", description: "An end-to-end test: a named stack with NO input and NO response that invokes other objects (`s.function.call`, `s.task.call`, `s.api.call`) and asserts on what they bind with `s.expect.*`. `datasource` defaults to `\"\"` (an EMPTY datasource, recommended); naming one makes the engine CLONE that datasource before every run, so pointing a test at production-sized data can be slow enough to fail the run — `\"live\"` warns at compile time.", registerMethod: "registerWorkflowTests" },
  { kind: "middleware", payloadKey: "middleware", authorFactory: "middleware", description: "A reusable pre/post stack attached to a query/function/task/tool/API group to run before or after its own logic.", registerMethod: "registerMiddleware" },
  { kind: "addon", payloadKey: "addon", authorFactory: "addon", description: "A reusable read fragment that enriches a query result by joining related table data.", registerMethod: "registerAddons" },
  { kind: "realtime_server", payloadKey: "realtime_server", authorFactory: "realtimeServer", description: "A realtime (websocket) server: the canonical-addressed container that owns realtime channels. Off until `enabled: true`. Returns a handle with `getUrl(baseUrl)`/`getPath()` for the client's socket URL (`wss://<host>/ws/<canonical>`).", registerMethod: "registerRealtimeServers" },
  { kind: "channel", payloadKey: "channel", authorFactory: "realtimeChannel", description: "A realtime channel: a joinable path on a realtime server (`rooms/{room_id}`) with typed path params, join/publish policy, a client-visible conversation transcript, and delivery semantics. Owns message handlers. Returns a handle with `getChannel(params)` for the path a client joins.", registerMethod: "registerRealtimeChannels" },
  { kind: "message", payloadKey: "message", authorFactory: "realtimeMessage", description: "A realtime message handler: a named message type on a channel with its own typed payload and stack — the realtime analogue of a query. Pass the `realtimeChannel()` handle as `channel` and the owning server comes with it.", registerMethod: "registerRealtimeMessages" },
  { kind: "microservice", payloadKey: "microservice", authorFactory: "microservice", description: "A container workload deployed alongside the workspace, called from a stack with `s.microservice.request`. Two mutually exclusive shapes via `kind`: `builtin` declares containers (image/ports/resources/env/command/args) plus optional `ingresses`, and `helm` points at a chart and its `values` — passing both throws. EARLY SURFACE, expected to change: `configs`/`volumes` are typed but unconfirmed against a live engine. SECRETS RIDE ALONG — `chart.values` and `registryAuth.dockerconfigjson` are carried into a pulled tree verbatim (they must be, or a pulled microservice could not be redeployed), so a tree holding a private-registry microservice holds a live credential; prefer leaving `dockerconfigjson` unset and supplying it out of band.", registerMethod: "registerMicroservices" },
  { kind: "workspace", payloadKey: "workspace", authorFactory: "workspaceConfig", description: "Workspace-level configuration such as default middleware chains and request-history defaults per host kind.", registerMethod: "registerWorkspace" },
];

/**
 * The engine's full object-kind catalog, and which SDK factory authors each.
 *
 * This is the coverage denominator. Every trigger type is its own engine kind
 * even though this SDK groups them under one `trigger` kind, so the mapping is
 * to a FACTORY rather than to an SDK kind name — otherwise seven authorable
 * kinds read as unimplemented.
 *
 * An entry with `authorFactory: null` is a kind you cannot author here and
 * cannot pull into a generated tree. Each says why, in the same two categories
 * codegen's omission policy uses: *unmodeled* (a real authoring surface this SDK
 * has not built) versus *instance-owned* (records of what was done TO a
 * workspace, which are not workspace source and have nothing to author).
 */
export const ENGINE_OBJECT_KINDS: ReadonlyArray<EngineObjectKind> = [
  { kind: "addon", authorFactory: "addon" },
  { kind: "agent", authorFactory: "agent" },
  { kind: "agent_trigger", authorFactory: "agentTrigger" },
  { kind: "api_group", authorFactory: "apiGroup" },
  { kind: "branch", authorFactory: null, absence: "instance-owned: a branch is instance state, not workspace source" },
  { kind: "channel", authorFactory: "realtimeChannel" },
  { kind: "channel_trigger", authorFactory: "realtimeChannelTrigger" },
  { kind: "error_trigger", authorFactory: "errorTrigger" },
  { kind: "function", authorFactory: "defineFunction" },
  { kind: "market_item", authorFactory: null, absence: "instance-owned: marketplace provenance belongs to the instance that installed it" },
  { kind: "mcp_server", authorFactory: "mcpServer" },
  { kind: "mcp_server_trigger", authorFactory: "mcpServerTrigger" },
  { kind: "message", authorFactory: "realtimeMessage" },
  { kind: "microservice", authorFactory: "microservice" },
  { kind: "middleware", authorFactory: "middleware" },
  { kind: "query", authorFactory: "query" },
  {
    kind: "realtime_channel",
    authorFactory: null,
    absence:
      "unmodeled: the SUPERSEDED workspace-global realtime channel. Its trigger is authorable (`realtimeTrigger`) so a legacy workspace's handlers survive a pull, but the channel object itself is not — author a `realtimeServer` + `realtimeChannel` instead",
  },
  { kind: "realtime_server", authorFactory: "realtimeServer" },
  { kind: "realtime_server_trigger", authorFactory: "realtimeServerTrigger" },
  { kind: "realtime_trigger", authorFactory: "realtimeTrigger" },
  { kind: "run.job", authorFactory: null, absence: "unmodeled: a container job — declares a main entrypoint plus pre/post steps and its env" },
  { kind: "run.service", authorFactory: null, absence: "unmodeled: a long-running container service — declares a pre step and its env" },
  { kind: "table", authorFactory: "table" },
  { kind: "table_trigger", authorFactory: "tableTrigger" },
  {
    kind: "tablemap",
    authorFactory: null,
    absence: "unmodeled: a column mapping over a table, used to shape an external schema onto it",
  },
  { kind: "task", authorFactory: "task" },
  { kind: "tool", authorFactory: "tool" },
  { kind: "workflow_test", authorFactory: "workflowTest" },
  { kind: "workspace", authorFactory: "workspaceConfig" },
  { kind: "workspace_trigger", authorFactory: "workspaceTrigger" },
];

/** Total engine object kinds — the size of the catalog above, never a literal. */
export const TOTAL_OBJECT_KINDS = ENGINE_OBJECT_KINDS.length;

/**
 * Statement-namespace notes rendered under the catalog heading, for families
 * whose surfaces are only meaningful inside a particular host object.
 */
const NAMESPACE_NOTES: Readonly<Record<string, string>> = {
  expect:
    "Assertions. **Put them in a `workflowTest({...})` stack** — assert on what a `.call` " +
    "bound with `as`. That is where they belong and effectively the only place to author " +
    "them. They are NOT inert elsewhere, which is the part worth knowing: a failure raises " +
    "and aborts whatever stack it is in, so an `s.expect.*` left in a `query`/`function`/" +
    "`task` takes the request down with an HTTP 500 carrying the assertion's own message " +
    "(`to_equal failed - expected value 2 does not equal 1`). Treat one outside a " +
    "`workflowTest` as a mistake to remove, not as a check that quietly does nothing. " +
    "Two behaviours to know when writing them: `to_throw` does not detect every " +
    "engine-raised failure (a hard fault escapes it and the assertion reports " +
    "\"response is ok\"), and `to_be_within` EXCLUDES both bounds — `min < expr < max` — " +
    "while `s.security.random_number`'s bounds are inclusive.",
  workflow_test:
    "Run another workflow test from inside one. Pass the `workflowTest()` def handle, " +
    "not a name.",
};

/**
 * Author factories on the PUBLISHED surface — every descriptor factory, minus
 * anything withheld by `unpublished`, and taking a kind's sub-kind factories in
 * place of its grouped brace-list.
 */
export const PUBLISHED_AUTHOR_FACTORIES: ReadonlySet<string> = new Set(
  KIND_DESCRIPTORS.filter((d) => !d.unpublished).flatMap((d) =>
    d.subKinds
      ? d.subKinds.filter((sub) => !sub.unpublished).map((sub) => sub.authorFactory)
      : [d.authorFactory],
  ),
);

/**
 * Engine kinds this SDK can author today. An `unpublished` factory is withheld
 * here exactly as it is from the catalog, so the numerator keeps meaning "what
 * an agent can reach right now".
 */
export const IMPLEMENTED_OBJECT_KINDS: ReadonlyArray<EngineObjectKind & { authorFactory: string }> =
  ENGINE_OBJECT_KINDS.filter(
    (k): k is EngineObjectKind & { authorFactory: string } =>
      k.authorFactory !== null && PUBLISHED_AUTHOR_FACTORIES.has(k.authorFactory),
  );

/**
 * The shortfall, with its reason — every engine kind the published surface
 * cannot author. Derived from the same catalog as the numerator, so the two can
 * never sum to anything but the total.
 */
export function unmodeledObjectKinds(): { kind: string; absence: string }[] {
  const implemented = new Set(IMPLEMENTED_OBJECT_KINDS.map((k) => k.kind));
  return ENGINE_OBJECT_KINDS.filter((k) => !implemented.has(k.kind)).map((k) => ({
    kind: k.kind,
    absence: k.absence ?? "built but withheld from the published surface",
  }));
}

/** Value constructors / helpers exported from the package root. */
const VALUE_CONSTRUCTORS: ReadonlyArray<ManifestValue> = [
  { name: "c.text", signature: "(s: string) => Value", description: 'String constant → tag "const".' },
  { name: "c.int", signature: "(n: number) => Value", description: 'Integer constant → tag "const:int".' },
  { name: "c.decimal", signature: "(n: number | string) => Value", description: 'Decimal constant → tag "const:decimal". Pass a string only to keep a stored spelling a number cannot reproduce (c.decimal("10.00") keeps its trailing zeros).' },
  { name: "c.blank", signature: '(tag: "const:<type>") => Value', description: 'The editor\'s UNCONFIGURED value box (stored value ""), emitted by codegen for a pulled workspace — do not author it. NOT a zero or an empty collection: the engine reads "" and "0" differently, so c.blank("const:int") ≠ c.int(0) and neither canonicalizes into the other. Constant tags except const/const:obj, whose blanks are c.text("")/c.obj(null).' },
  { name: "c.bool", signature: "(b: boolean) => Value", description: 'Boolean constant → tag "const:bool".' },
  { name: "c.null", signature: "() => Value", description: 'Null constant → tag "const:null".' },
  { name: "c.obj", signature: "(o?: Json | null) => Value", description: 'Object constant → tag "const:obj". A populated one stores an empty {} carrying one `set` filter per key — the editor\'s form, and the only populated form the engine reads back (a populated JSON string arrives truncated and fails the request with ERROR_FATAL "Unable to decode."). ⚠ a ZERO-BASED numeric key is an INDEX in the engine\'s data model, so c.obj({"0":"a"}) evaluates to the list ["a"] (a non-zero-based one like {"2":…} survives as a key) — that is the platform, not this encoding. No argument = the empty object {} — use this one. Explicit null = the legacy blank form the engine evaluates to null, NOT {}; it exists only so a pulled workspace round-trips, do not author it. Plain JSON literals only — a nested tagged value (inp/ref/auth/c.*) is rejected; for a computed object response use a record of values, not c.obj.' },
  { name: "c.array", signature: "(a: Json[]) => Value", description: 'Array constant (JSON string) → tag "const:array". Plain JSON literals only — a nested tagged value is rejected, same as c.obj.' },
  { name: "c.expression", signature: "(source: string) => Value", description: 'Xano Expression Engine source, passed through VERBATIM → tag "const:expr2". The string IS the expression: c.expression(\'"Hi, " ~ $input.name\'), c.expression("$var.price * $var.qty"). ⚠️ NOT VALIDATED — never parsed or type-checked, invisible to InferResponse, and untouched by a rename that updates every typed ref(); a typo surfaces at runtime or as a wrong answer. Use it ONLY for syntax the typed surfaces cannot express (~ concatenation, inline arithmetic, conditionals) — prefer ref/inp/col, withFilters+fl.*, and obj() (which BUILDS a checked expression). Not the expr() condition builder.' },
  { name: "c.expressionLegacy", signature: "(source: string) => Value", legacy: true, description: 'the older `const:expr` expression form, emitted by codegen for workspaces that still hold one — author `c.expression` instead.' },
  { name: "c.now", signature: "() => Value", description: 'Current time as epoch-ms — the engine-native const:epochms constant (no filter). Valid inline as a where/cmp operand. For cutoff math (cutoff = now - max_age) either compare inline or, for reuse/readability, hoist it into an s.set_var and compare against the var.' },
  { name: "obj", signature: "(fields: Record<string, Value | nested>) => Value", description: 'Dynamic object value → tag "const:expr2" (an object-literal expression string). The dynamic sibling of c.obj: members may be inp/ref/auth/col values, env()/setting()/sys.*, c.now(), c.* constants, nested records, or arrays — and each member may carry a FILTER CHAIN (withFilters + fl.*), which renders as the expression pipe `$var.row|get:"a.b"`. That matters most for the null-safe drill: db.get binds null on a miss, so ref(path, { safe: true }) inside an obj() is the normal shape, not a workaround — you do NOT need a preceding s.set_var to hoist it. Still rejected: a filter ARGUMENT carrying its own chain (a trailing | binds to the whole value, not one argument), a DISABLED filter (an expression string cannot record that), and the output/response/toolset/reg tags — build those in a prior step and ref() them. Use for e.g. s.ai.agent.run args.' },
  { name: "ref", signature: "(name: string, opts?: { safe?: boolean }) => Value", description: 'Reference a stack variable → tag "var". Pass { safe: true } for null-safe nested access — a dotted ref("owner.user_id", { safe: true }) compiles through the get filter so it resolves to null instead of raising "Unable to locate var" when the base is null.' },
  { name: "inp", signature: "(name: string) => Value", description: 'Reference a function input → tag "input".' },
  { name: "col", signature: "(name: string) => Value", description: 'Reference a table column → tag "col".' },
  { name: "auth", signature: "(path?: string) => Value", description: 'Reference the authenticated identity (auth("id") → $auth.id) → tag "auth".' },
  { name: "caught", signature: '(path?: "code" | "message" | "name" | "result") => Value', description: 'Read the caught error inside an s.try_catch CATCH arm → tag "trycatch". Valid ONLY there — it reads empty in the try/finally arms and outside the statement. Those four fields are all the engine binds (result is the attached payload); bare caught() is the whole error record. \u26a0 For an ENGINE-raised exception only `code` and `name` are populated; for an `s.throw`, `message` is the fixed string "Throw Error Statement" and your text is in `result`. So `caught("name")` is useful in both cases and `caught("message")` in NEITHER.' },
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
  // util.* — two whose UNITS and SHAPE cost teams time, and neither is guessable
  // from the signature.
  "util.geo_distance": {
    name: "as",
    type: "number",
    note: "great-circle distance in METRES (a decimal) — divide by 1000 for km. Identical points return 0",
  },
  "util.ip_lookup": {
    name: "as",
    type: "IpLookupResult | null",
    note:
      "NESTED, not flat: { continent: {code,name}, country: {code,name}, region: {code,name}, city: {name}, postal: {code}, location: {latitude, longitude, tz, radius} }. Coordinates are ref(\"geo.location.latitude\"/\".longitude\"), place names ref(\"geo.city.name\"/\"geo.region.name\"/\"geo.country.name\"); radius is KILOMETRES. ⚠ Every leaf is nullable and region/city/postal commonly ARE null for a routable public address — that is a normal hit, not a failed lookup. `city` is an OBJECT, so a bare ref(\"geo.city\") into a text column fails on the object and { safe: true } does NOT help; drill to city.name with a fallback. The whole var is null for an unresolvable address",
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
    if (r.enum !== undefined) f.enum = r.enum;
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
      // Counted over the ENGINE's catalog, not over this SDK's kinds: the engine
      // has one object kind per trigger type where the SDK has one `trigger`
      // kind with sub-kinds, so counting SDK kinds reported 16/30 for a surface
      // that actually authors 23 of them.
      objectKinds: {
        implemented: IMPLEMENTED_OBJECT_KINDS.length,
        total: TOTAL_OBJECT_KINDS,
        unmodeled: unmodeledObjectKinds(),
      },
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
    cli: buildCli(),
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
  // A constrained field renders as its legal values rather than the opaque
  // `value`. This is the whole point of carrying the constraint: an agent
  // reading `connection_type?: value` has no way to know the two spellings the
  // engine accepts, and guessing a plausible third one fails only after deploy.
  const type = f.enum ? f.enum.map((v) => JSON.stringify(v)).join(" | ") : f.type;
  return `${f.name}${f.optional ? "?" : ""}: ${type}${keepDefault ? ` = ${JSON.stringify(f.default)}` : ""}`;
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
  // The `code` arg is a JS FUNCTION BODY (it must `return`), not a column path,
  // and which identifiers it can see depends on the filter — see **Lambda bodies**.
  // Build it with `lam.fn`, which makes the bindings the function's parameters.
  map: "`code` is a JS body run per element, over `$this`/`$index`/`$parent` — build it with `lam.fn`",
  filter: "`code` is a JS body run per element (keep it? true/false), over `$this`/`$index`/`$parent`",
  every: "`code` is a JS body run per element (true for all?), over `$this`/`$index`/`$parent`",
  some: "`code` is a JS body run per element (true for any?), over `$this`/`$index`/`$parent`",
  find: "`code` is a JS body run per element; returns the first element it accepts",
  findIndex: "`code` is a JS body run per element; returns the first matching index",
  reduce:
    "`code` is a JS body run per element; the ACCUMULATOR is `$result` (there is no `$acc`) and " +
    "`initial_value` is REQUIRED — omitting it would slot the code as the initial value",
  lambda: "runs a JS body once over the piped value, which it binds as `$this` (NOT `$parent`)",
  // The one filter next to `lambda` that is NOT a lambda. It reads as one, its
  // upstream description names a `$this` that does not exist on its path, and
  // both wrong spellings can return a plausible value with HTTP 200 — so the
  // note has to say what the binding IS, not only what it isn't.
  transform:
    "`expression` is Xano Expression Engine source, NOT a JS body — no `return`, and the piped value is " +
    "`$0` (or `$$`), NOT `$this` (which is null here). `$var`/`$input`/`$env`/`$auth` resolve and filters " +
    "pipe inside it: `$0 * 2`, `$0|sort|join:\",\"`. Parenthesize a pipe inside an object literal — " +
    "`{ s: ($0|sort|join:\",\") }` — or its comma is read as the key separator and later keys vanish " +
    "silently. For JavaScript use `lambda`",
  // The sort mode is the whole behavior of this filter, and picking it wrong is
  // SILENT — every unrecognized spelling falls through to `itext`, so the array
  // comes back sorted as case-insensitive text with no error anywhere. That is
  // how "top N by score/distance/recency" comes out wrong (#198).
  fsort:
    '`type` is the comparator, and ONLY "number" compares numerically — "text"/"itext" ' +
    'are strcmp/strcasecmp, "natural"/"inatural" are the human-readable "a2 < a10" ' +
    'orderings. Default "itext". Anything else silently sorts as text, so a numeric ' +
    'sort MUST spell "number"; the path arg drills into each element',
  // The CSV pair reads as interchangeable and is not: only `csv_create` writes a
  // header, and `csv_encode`'s per-row column order misaligns heterogeneous rows
  // with no error at all (#246).
  csv_encode:
    "writes NO header — values only, each row in THAT row's key order with no normalization " +
    "across rows, so rows whose keys differ in order or count silently misalign columns. " +
    "Nested cells are JSON-encoded and `false` writes empty. A piped array of SCALARS is " +
    "treated as one row. Use `csv_create` for a header",
  csv_create:
    "the header-writing counterpart to `csv_encode`: the PIPED value is the list of column " +
    "names (written as the header line) and `rows` carries the data rows",
  // A group-by whose name reads as a lookup table. The singular spelling
  // `idx[key].name` is null at runtime rather than an error (#267).
  index_by:
    "a GROUP-BY: every value is an ARRAY of the items sharing that key, even when only one does, " +
    "so a lookup reads `idx[key][0]`. Items whose path is missing or non-scalar are dropped",
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
/**
 * The one canonical statement of the lambda binding contract (issue #221).
 *
 * Generated from {@link LAMBDA_BINDINGS} — the same table the build-time guard
 * reads and the same one the live probe agreed with — so the docs cannot
 * disagree with what the SDK enforces or with what the engine does. Before this,
 * the contract was written down nowhere at all: the reporter guessed `$acc` for
 * reduce's accumulator, and nothing between the keystroke and production
 * disagreed.
 */
/** Wrap `items` into ` · `-joined lines that stay inside the doc's column width. */
function wrapList(items: readonly string[], indent: string, width = 84): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line === "" ? indent + item : `${line} · ${item}`;
    if (next.length > width && line !== "") {
      lines.push(line + " ·");
      line = indent + item;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function renderLambdaSection(): string[] {
  const lines: string[] = ["## Lambda bodies (JavaScript)", ""];
  lines.push(
    "The lambda statement (`s.lambda({ as, code, timeout? })`) and eight filters run a",
    "JavaScript body. **Write the body as a FUNCTION, not a `c.text` string** — the",
    "bindings are its parameters, so the editor supplies them and a wrong name is a",
    "compile error instead of a wrong value at runtime. Write it inline and the surface",
    "is implied by where it sits; nothing names one:",
    "",
    "```ts",
    "fl.map(({ $this }) => $this * 2)                                   // map's bindings, typed from the position",
    "fl.reduce({ initial_value: 0, code: ({ $result, $this }) => $result + $this })",
    "s.lambda({ as: \"total\", code: ({ $var }) => $var.subtotal * 1.2 })  // ambient only — $this is a compile error",
    "```",
    "",
    "The parameters are a fiction — only the BODY is sent, and the engine injects the",
    "bindings as free identifiers — so DESTRUCTURE them. `(b) => b.$this` emits",
    "`return b.$this`, and `b` is undefined at runtime (the SDK refuses it).",
    "",
    "For a body built away from its call site:",
    "",
    '- `lam.fn(({ $result, $this }) => $result + $this, { surface?, capture? })` — name a `surface` to check it here, or omit it and the call site checks it.',
    '- `lam.raw("return 1", { surface })` — text, same validation.',
    '- `lam.file("./lambdas/total.ts")` — a default-exported function in its own type-checked module, read as text at build time. The deterministic option under a bundler, where a function\'s source is whatever the bundler emitted. NODE ONLY, and it is the `lam` import that changes: `import { lam } from "@sidestep/core/node"`. The isomorphic `lam` has no `file` (no filesystem in a browser bundle); its `fn` and `raw` are the same functions.',
    "",
    "A body is a FUNCTION BODY: it must `return` its value. Bindings by surface — an",
    "identifier outside its surface's set is undefined at runtime, and the SDK refuses",
    "it at build time whichever spelling you use:",
    "",
  );
  const ambient = LAMBDA_BINDINGS["s.lambda"];
  const tick = (x: string): string => `\`${x}\``;
  lines.push(
    `- every surface: ${ambient.map(tick).join(" · ")} (+ the ${LAMBDA_GLOBALS.map(tick).join(" / ")} globals)`,
  );
  const extras = (surface: LambdaSurface): string[] =>
    LAMBDA_BINDINGS[surface].filter((b) => !ambient.includes(b));
  const byExtras = new Map<string, string[]>();
  for (const surface of Object.keys(LAMBDA_BINDINGS) as LambdaSurface[]) {
    if (surface === "s.lambda") continue;
    const key = extras(surface).join(" ");
    byExtras.set(key, [...(byExtras.get(key) ?? []), surface]);
  }
  for (const [key, surfaces] of byExtras) {
    const label = surfaces.map((x) => tick(x.includes(".") ? x : `fl.${x}`)).join(" · ");
    lines.push(`- ${label}: + ${key.split(" ").map(tick).join(" · ")}`);
  }
  lines.push(
    `- \`s.lambda\`: ambient only — no \`$this\`, no \`$parent\`, no \`$result\`.`,
    "",
    "`$result` is `reduce`'s ACCUMULATOR (there is no `$acc`). `$this` is the element in",
    "an iterating filter and the piped value in `fl.lambda`; `$parent` is the whole array",
    "and exists only on the iterating filters. A stack variable is reached as",
    "`$var.name` — it is NOT also injected as a bare `$name`.",
    "",
    "Three hazards and the dependency route, all live-verified:",
    "",
    "- ⚠ A body that THROWS does not fail the request: the engine returns its diagnostic",
    "  TEXT as the value with HTTP 200, so the failure reads as bad data. Validate before",
    "  consuming a lambda result numerically, and prefer a `lam.*` body, which cannot fail",
    "  this way for a binding reason.",
    "- ⚠ A top-level `import`/`export` is a syntax error — the body is a function body, not",
    "  a module. Reach a dependency through the PRELOADED globals below, which need no",
    "  specifier. A dynamic `import(\"…\")` or `require(\"…\")` with a LITERAL specifier is not",
    "  portable: on an instance that bundles the body before running it, every literal",
    "  specifier is resolved ahead of time against a filesystem where none of them exist, so",
    "  `await import(\"node:crypto\")` comes back as the TEXT `Could not resolve \"node:crypto\"`",
    "  with HTTP 200. Other instances resolve it at run time and it works — so it is",
    "  instance-dependent, and only the globals are not.",
    "- Preloaded globals, live-probed — no specifier, so these work everywhere:",
    ...wrapList(LAMBDA_MODULE_GLOBALS.map(tick), "  "),
    "  …plus `fetch`, `Buffer`, `TextEncoder`/`TextDecoder`, and the `crypto` above",
    "  (`randomUUID`, `createHmac`, `subtle` all present). `Object.keys(globalThis)`",
    "  inside a body lists whatever else a given instance carries.",
    "- ⚠ `console` output goes to the request LOG, not stdout.",
    "",
    "TypeScript annotations survive in the body, and top-level `await` works.",
    "",
  );
  return lines;
}

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
    // The shortfall by name: an agent that cannot see WHICH kinds are missing
    // will invent a factory for one. Reasons live in `manifest.json`.
    `Not authorable here: ${m.coverage.objectKinds.unmodeled.map((k) => k.kind).join(", ")} — ` +
      "these cannot be authored and do not survive a pull; see `coverage.objectKinds.unmodeled` in `manifest.json`.",
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
    "In LOCAL DEV there is no injected global, so the fallback is what answers: set",
    "`VITE_XANO_HOST` in a `.env.local` beside `.env.example` at the PROJECT ROOT. The",
    "scaffold's vite config sets `envDir` there (its `root` is `frontend/`, and Vite",
    "resolves `.env` files against `root`) — without it the var reads as undefined, the",
    "host falls back to '', and every call 404s off the dev server.",
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
    "  Works inside `obj({...})` too — no per-member `s.set_var` hoist needed.",
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
    "  `nullable: true`) — inline (`seed: [{ name: \"…\" }]`), a FILE",
    "  (`seed: seedFile(\"./seed.json\", import.meta.url)`; path resolves against the DECLARING",
    "  file), or a thunk (`seed: () => import(\"./seed.json\")`, async ok, `.default` unwrapped).",
    "  All keep row/column typing. ⚠ Use `seedFile` for a file: a thunk's `import()` sits in",
    "  YOUR module, so a bundler emits the JSON as a served chunk and any frontend importing",
    "  a def that reaches the table ships it. Never put secrets in `seed`;",
    "  `deploy --static` refuses a build carrying internal/sensitive seed values.",
    "  Deploy is a full replace, so re-deploying re-seeds",
    "  cleanly (no duplication). Omit `id` and rows auto-number `1..N` (int PK) or take",
    "  a stable derived uuid (uuid PK); supplying `id` pins it (engine preserves it,",
    "  resets an int sequence past the max). All-or-nothing — mixing explicit and",
    "  omitted `id` throws. A `system:false` PK is the author's to supply. Pinning is",
    "  `seed`-only — `s.db.bulk.add` DROPS `id` unless `allowIdField: true`.",
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
    "- **Client bundle size / tree-shaking.** `@sidestep/core` is `sideEffects: false` and pulls",
    "  no Node built-ins, so a bundler drops unused SDK exports. But importing a **def** for its",
    "  `getPath()`/`verb`/`getUrl()`/`getChannel()` also pulls whatever its `stack` references:",
    "  the `s.*`/`c.*` factory CALLS run at module load to BUILD it. Types are free.",
    "  ⚠ A FLOOR — **~37 kB minified** for the FIRST def; splitting modules never removes it.",
    "  Fix: `sidestep routes <entry> --emit xano/routes.gen.ts` — verbs, paths, and sockets as",
    "  plain data importing NOTHING, still compile-checked: `routePath(\"blog/{slug}\", { slug })`,",
    "  `channelPath(\"rooms/{room_id}\", { room_id })`, `socketUrl(\"chat\", baseUrl)` (tenant base",
    "  URLs lifted to `wss://h/ws/<tenant>:<canonical>`). A rename is a type error, not a 404.",
    "- **Intra-workspace imports use `.js` specifiers** (`../tables/links.js`), not",
    "  extensionless — the defs compile under `moduleResolution: bundler`. Add the `.js`.",
    "- **Verifying a def outside a bundler.** Inside a bundler (Vite/webpack) importing a",
    "  query def to read `getPath()`/`verb` works directly. To spot-check from Node, run a REAL",
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
    "- **`f.password()` defaults to `access: \"internal\"`, so `db.get` does NOT return it.**",
    "  A login stack that reads `ref(\"u.password\")` after a plain `db.get` fails at runtime",
    "  with `Unable to locate var: u.password` — the column is simply absent from the row.",
    "  Name it in the read's `output` to pull it: `s.db.get({ table: users, fieldName: \"email\",",
    "  fieldValue: inp(\"email\"), output: [\"id\", \"email\", \"password\"], as: \"u\" })`, then",
    "  `s.security.check_password`. `output` OVERRIDES column visibility — it is the only way to",
    "  read an `internal` column, and `export()` warns when a stack reads one a `db.get` did not",
    "  return.",
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
    "- **Event-driven objects fire on an EPHEMERAL, not in the sandbox.** A `task`",
    "  (scheduled), an `mcpServer`, and every trigger — `tableTrigger` included — run normally",
    "  on an ephemeral env, which is `deploy`'s DEFAULT destination. So test an event-driven",
    "  design (screen-on-insert, cron cleanup, MCP tool call) by deploying it and letting it",
    "  run.",
    "  ⚠ Under `--dest sandbox` they import cleanly but their stacks NEVER execute, and there",
    "  is no way to fire one manually — an insert on a bound table does not run its",
    "  `tableTrigger`, and the design silently does nothing. Only synchronously-invoked objects",
    "  (queries, functions, and the agents an endpoint calls with `s.ai.agent.run`) run there.",
    "  If you must stay on the sandbox, verify the logic out of band: factor the body into a",
    "  `defineFunction` (or a callable `query`) and invoke it directly — a `tableTrigger` that",
    "  screens a row on insert should delegate to a function a `query` can also call via",
    "  `s.function.run`, and you assert against that.",
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
    "  - `name` is the endpoint PATH within the group. A `{param}` segment is a URL PATH PARAM bound to the input of the same name, and segments chain: `name: \"blog/{slug}/review/{review_id}\"` + `input: { slug: input.text(), review_id: input.int() }`. Read it with `inp(\"slug\")` like any other input. Every `{param}` MUST have a matching input or `query()` THROWS — Xano treats an unbound marker as inert route text, so the endpoint would answer on the path and see nothing. A `{param}` need NOT be a whole segment (`\"blog/post-{slug}\"` routes fine), but its type must fit one segment (no object/list/json/file/geo/vector); there are no wildcards or patterns. `required: true` is NOT demanded (the engine's editor leaves path inputs unmarked). Inputs absent from the path are ordinary query-string/body params. Name charset is ONLY `A-Za-z0-9_-/{}`, max 200: a `.` (`\"export.zip\"`) is NOT rejected by Xano — it stores an EMPTY name that deploys clean then 404s forever, so `query()` THROWS. Use `\"export_zip\"` and set the extension in the response headers.",
    "  - **Client recipe:** `q.getPath({ params: { slug: \"hello\" } })` → `/api:<canonical>/blog/hello` — never interpolate by hand (a value containing `/` would address a different endpoint; `getPath` throws instead). The keys are typed from the literal `name`, so a typo is a compile error. The HANDLE's `q.toSearchParams(input)` drops path params for a GET; the free `query.toSearchParams(input)` has no view of the route and keeps every key.",
    "- `apiGroup({ name, guid?, canonical?, description?, docs?, swagger?, apiGroupEnabled?, documentation?, cors? })` — a query container; register it and bind queries to it via their `apiGroup`.",
    "  - `cors?`: `{ mode?, allowOrigins?: string[], allowHeaders?: string[], allowCredentials?, maxAge?, allowMethods?: { get?, post?, put?, patch?, delete?, head? } }`.",
    "- `defineFunction`/`query`/`apiGroup` above cover the queries+tables core; the five below are the \"reach past that\" primitives (agents, tools, tasks, middleware, MCP servers). Same envelope conventions (`guid?`, `description?`, `docs?`, `tags?`, `history?`) unless noted.",
    "- `task({ name, guid?, description?, docs?, datasource?, active?, tags?, history?, schedule?, stack?, middleware? })` — a scheduled background job (function-like `stack`, no `input`/`response`).",
    "  - `schedule?`: a `ScheduleDef[]` (NOT a single object) — `{ startsOn, freq?, repeatEnabled?, endsOn?, endsEnabled? }`. `startsOn`/`endsOn` are **ISO-8601 string** timestamps (`\"2026-01-01T00:00:00Z\"`), not epoch numbers; `freq` is the repeat interval **in seconds** (default `86400` = daily); `endsOn` present ⇒ the schedule has an end. `endsEnabled?` defaults to that and is recovery-only — state it to reproduce a stored schedule that remembers an end date with the gate OFF. Fires on an ephemeral; does NOT fire in the sandbox (see Gotchas).",
    "- `workflowTest({ name, guid?, description?, docs?, datasource?, active?, tags?, stack? })` — an end-to-end test. NO `input`/`response`: `.call` something with an `as`, then assert on that var — `s.function.call({ fn, input, as: \"r\" })`, `s.expect.to_equal({ expr: ref(\"r\"), value: c.int(42) })`. `s.expect.*` belongs here — it is not inert elsewhere (a failure 500s the request), so treat one in a query/function/task as a mistake to remove. `active?` defaults `true`; chain tests with `s.workflow_test.call({ workflowTest: <def handle> })`.",
    "  - `datasource?`: **the trap.** Default `\"\"` is an EMPTY datasource (recommended), not \"no datasource\". Any non-empty name makes the engine CLONE it before EVERY run — against production-sized data, slow enough to fail the run. `\"live\"` warns at compile time; other names don't.",
    "- `middleware({ name, guid?, description?, docs?, resultStrategy?, exceptionPolicy?, tags?, history?, input?, stack?, response? })` — a pre/post interceptor (function-like `stack`); attach it via a host's `middleware: { pre, post }`.",
    "  - `resultStrategy?`: `\"merge\" | \"replace\"` (default `merge`) — how the middleware `response` folds into the host's.",
    "  - `exceptionPolicy?`: `\"silent\" | \"rethrow\" | \"critical\"` (default `\"rethrow\"` — a throw ABORTS the request and surfaces the authored error/status, which is what a guard wants). `\"silent\"` swallows the throw and lets the request through, so a guard set to it is NOT enforced — use it only for advisory middleware. `\"critical\"` is `\"rethrow\"` plus skipping the `post` chain.",
    "- `tool({ name, guid?, description?, instructions?, docs?, enabled?, tags?, history?, input?, stack?, response?, middleware? })` — a function-like operation (`input`/`stack`/`response`) that a toolset (MCP server or agent) exposes. Register it, then reference it from a toolset's `tools`.",
    "- `mcpServer({ name, guid?, description?, instructions?, docs?, enabled?, canonical?, spec?, tags?, history?, tools?, llm?, output? })` — an MCP toolset. `llm?`/`output?` are the same blocks `agent()` takes and are usually absent: an MCP server and an agent are ONE stored object distinguished by `type`, so a server that carries LLM settings can say so. Returns a handle with `getPath()`/`getUrl(baseUrl)` for the Streamable-HTTP endpoint. Fires on an ephemeral; does NOT fire in the sandbox (see Gotchas).",
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
    "    - `name` is a PATH (`\"lobby\"`, `\"rooms/{room_id}\"`); `input` types its `{param}` segments, NOT the payload. Every `{param}` MUST have a matching input or `realtimeChannel()` THROWS. Name charset as query (`A-Za-z0-9_-/{}`, max 200), and so is `tool`; `realtimeMessage` is NARROWER — no `/` or `{}`.",
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
    "    - `authenticated` bool · `client_id` text (the AUTHED ROW ID as text, `\"\"` anonymous) · `dbo_id` int (the auth TABLE's id — NOT the user's row id; `0` anonymous — to look the caller up use `client_id`. `dbo_id` is an int in the same position and typechecks, so a gate that keys on it finds no user and refuses EVERYONE) · `socket_id` int (transport id) · `channel` text (resolved path, `\"\"` in a server trigger) · `params` object (bound path params, `{}` when none — `ref(\"session.params.room_id\")`) · `extras` object · `opened_at` decimal.",
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
    "- `realtimeServerTrigger({ name, realtimeServer, actions?: {connect?,disconnect?}, stack?, response? })` — realtime SERVER lifecycle (a client connecting to / disconnecting from the server, not a message). Inputs: `t.action` (`connect|disconnect`), `t.realtime_server`, `t.client`. Bind `realtimeServer` to a `realtimeServer()` handle (or its name). `connect` GATES the connection — a denial sends an `error` and CLOSES the socket with code 4401 before it is ever ready, so it is a real front door, not an observer; same return shape as a channel `join` (`{ allowed: true }` or any truthy value admits, EMPTY/FALSY DENIES — INCLUDING a gating trigger with NO `response`, which returns nothing and so refuses every client). A CRASH DENIES too — the transport seeds a deny and keeps it on a throw. Both failure modes lock the door, so plan for a self-inflicted LOCKOUT (an unguarded drill into a null `db.get` raises → everyone refused), not a breach. Gating is OPT-IN: a server with no `connect` trigger accepts every connection. `disconnect` is OBSERVATIONAL (return ignored, throws swallowed — cleanup must always complete). Both are SERVER-scoped, so `s.realtime.get_session` works but carries no channel path and no bound params.",
    "- `realtimeChannelTrigger({ name, channel, actions?: {join?,leave?,deliver?}, stack?, response? })` — realtime CHANNEL lifecycle. Inputs: `t.action` (`join|leave|deliver`), `t.channel`, `t.client`. Bind `channel` to a `realtimeChannel()` handle — a bare path is NOT accepted (it is unique only within its server). The three actions have DIFFERENT postures, and the posture decides what the stack should return: `join` GATES the join (it runs BEFORE the client becomes a member, so a denial means it never sees a fan-out) — return `{ allowed: true }` (optional `reason` reaches the client) or any truthy value to admit, and an EMPTY OR FALSY RETURN DENIES, so a stack that just falls through — or a gating trigger with NO `response` — refuses everyone, and a CRASH DENIES too. That is the inverse of a normal message (a crashing message still delivers) and of `deliver` below (a gate that fails OPEN). `join`/`leave` bind the channel's typed path params as INPUTS, so `inp(\"room_id\")` resolves and the gate decides per room; a SERVER connect/disconnect has no channel, the one place a path param cannot be read; `leave` is OBSERVATIONAL (return ignored, throws swallowed); `deliver` GATES delivery PER RECIPIENT — the per-viewer redaction tool and the most expensive action here (a stack per recipient per message), and it needs `delivery.perRecipient` on the channel to run at all. **`deliver`'s RETURN VALUES DO NOT READ LIKE A FILTER:** ONLY an explicit NULL drops the message for that recipient; an OBJECT replaces that recipient's payload; ANYTHING ELSE — INCLUDING `false`, `0`, `\"\"` — DELIVERS IT UNCHANGED, as does a crash. So `return false` from a yes/no redaction check SENDS the message it was written to suppress — return null instead. The delivered payload arrives NESTED, so read `inp(\"payload\").<field>`, and `t.client` is the SENDER while `s.realtime.get_session` describes the RECIPIENT this run is for.",
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
    "- ⚠ The wider `cmp` operators are DATABASE-only (`where`, table view filter, db trigger",
    "  `search`). A RUNTIME condition — `s.conditional`/`elif`, `s.while`, `s.precondition`,",
    "  `array.*` `if` — takes the `expr` set only; the rest are refused at build time because",
    "  deployed they fail the request with `Invalid op: <op>` on that branch, usually a guard.",
    "  Spell membership out: `or(expr(x, \"=\", a), expr(x, \"=\", b))`.",
    "- A condition/`where` accepts a single `expr(...)`/`cmp(...)`, an `and()`/`or()` group, an array of",
    "  those (ANDed), or (for `where`) a raw `Value`. `s.conditional`/`s.while`/`s.switch`, `db.query`,",
    "  `precondition`, and the `array.*` predicates all take the same TREE shape (operators per above).",
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
    "`default`, `description`.",
    "**`nullable` defaults PER TYPE, matching the engine's own column-creation API**: `true`",
    "for `f.vector`, `f.uuid`, every `f.geo.*` and every file type (`f.image`/`f.video`/",
    "`f.audio`/`f.attachment`), `false` for everything else (text, int, decimal, bool, email,",
    "enum, json, object, password, date, tableRef). Pass `nullable` explicitly to override —",
    "e.g. `f.geo.polygon({ nullable: false })`. This is why `f.vector(8)` deploys: the engine",
    "turns an empty default into SQL NULL only for a nullable column, so a non-null vector",
    "would reach PostgreSQL as `vector(8) not null default ''` and fail to create.",
    "**`f.geo.*` values are `{ type, data }`, not GeoJSON.** The same shape goes in and comes",
    "back: `{ type: \"point\", data: { lng, lat } }`, `{ type: \"poly\", data: [{ lng, lat }, …] }`",
    "— `type` is the engine's abbreviation, and a polygon ring is closed for you. Raw WKT text",
    "(`c.text(\"POINT(1 2)\")`) is accepted on write too, but a read never returns one.",
    "`methods` is a bind-time validator/transform pipeline whose",
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
    "only for rules no type expresses (README: \"Validate input at the boundary\").",
    "⚠ `s.precondition`'s `error` must be a TAGGED value — `c.text(\"…\")`, not a bare string.",
    "The engine falls back to the generic \"Precondition failed.\" whenever it reads an empty or",
    "non-scalar message, and a bare string lands there, so the client never sees your text. The",
    "`error_type` → HTTP status mapping is correct either way; only the message is lost. The bare",
    "form stays accepted so a pulled workspace round-trips, not as a spelling to choose.",
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
    "A bare JS **scalar** — string, number or boolean — is accepted in ANY `fl.*` argument and",
    "wrapped as the constant you would have written by hand (`fl.get(\"a.b\", 0)` encodes",
    "identically to `fl.get(c.text(\"a.b\"), c.int(0))`). An object or array must still be built",
    "with `c.obj`/`c.array`. The arg types below name each argument's ENGINE type, not the JS",
    "type you may pass.",
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
    // An enumerated arg prints its MEMBERS, not the word "enum". Printing the
    // word is what made #198 expensive: the accepted set was discoverable only
    // by trying spellings against a live engine, and the one that behaves
    // differently from the rest is not guessable.
    const sig = (fl.args ?? [])
      .map((a) => {
        const type = a.enum?.length ? a.enum.map((m) => JSON.stringify(m)).join("|") : a.type;
        return `${a.name}${a.optional ? "?" : ""}: ${type}`;
      })
      .join(", ");
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

  lines.push(...renderLambdaSection());

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
    "- **Statements with an `as`** also take `asFilters?` — `fl.*` filters on the RESULT as it binds, in order, same slot as `disabled`: `s.set_var(\"x\", v, { asFilters: [fl.trim(), fl.lower()] })`. Saves a follow-up `set_var`. Throws without an `as`. The bound variable is RETYPED by the chain (`db.query` + `[fl.count()]` → `number`); filters whose result the engine declares as `any` (`get`, `set`, `json_decode`, …) fold to `unknown`.",
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
    "- `s.array.map({ source, as?, transform? })` — `transform` is either a per-item `Value` expression (each item maps to that value) or a **record of values** (each item maps to an object with those keys). Use `ref(\"$this\")` for the item and `ref(\"$index\")` for its position. These are THIS statement's own bindings, in a value expression — not the JavaScript lambda contract (see **Lambda bodies**), which binds a different set per surface and is written with `lam.fn`.",
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
    "- `s.db.query({ table, where?, additionalWhere?, bind?, sort?, paging?, external?, returnType?, distinct?, eval?, output?, lock?, addon?, as? })` — search.",
    "  - `where` / `additionalWhere` — `expr(...)`, an `expr[]` (ANDed), or a raw `Value`. Rides `context.search`.",
    "    - ⚠ `ignoreEmpty` DROPS the predicate when the operand is empty — it does not match zero rows. On an `in` comparison an empty list therefore returns the UNFILTERED set, so never use it to scope rows to a permitted-id list: an empty list of permissions returns everything.",
    "    - For the full operator set use `cmp(left, op, right, { ignoreEmpty? })` — `op`: `in`/`not in`/`like`/`ilike`/`between`/`contains`/`includes`/`overlaps`/`@>`/`~`/`search`/… plus the `expr` comparisons. Database-only — a runtime condition takes the `expr` set only.",
    "    - Compose nested boolean logic with `and(...)` / `or(...)` groups (also available on `addon()` `where`).",
    "    - An operand may be a bare value (`col`/`inp`/`ref`/`auth`/`c.*`) OR a **filtered** value (`withFilters(...)`) inline. Hoisting into a prior `s.set_var` is a readability option, not a requirement.",
    "  - `bind: [{ table, as?, join?, where? }]` — joins (`context.bind[]`). `join` defaults to `\"inner\"`. `as` defaults to the table name; two joins to the same table need distinct aliases.",
    "    - ⚠ In `where`/`sort`/`eval` a JOINED column takes a dotted path (`col(\"team_row.id\")`); THIS query's own columns stay **bare** (`col(\"team\")`). Qualifying your own by table name needs `tableAlias` (same rule as `aggregate`) — without it the engine reads the operand as text and 400s `ParseError: Invalid value for param` naming the OTHER operand, so it throws at export instead.",
    "    - `bind: [{ table: team, as: \"team_row\", join: \"left\", where: expr(col(\"team\"), \"=\", col(\"team_row.id\")) }]`",
    "  - `returnType` — `\"list\"` (default) | `\"single\"` | `\"count\"` | `\"exists\"` | `\"stream\"` | `\"aggregate\"`. Drives `context.return.type` AND the `InferResponse` shape: `count`→`number`, `exists`→`boolean`, `single`→`Row|null`, `stream`→`Row[]` (pageable, no envelope), `list`→`Row[]`/envelope, `aggregate`→rows keyed by the `aggregate.group`/`eval` aliases. ⚠ A bare `count` of ZERO serializes as an EMPTY body, not `0` — a client parsing JSON gets a parse error on the one result it most needs to handle. Wrap it: `response: { count: ref(\"n\") }`.",
    "  - `eval: [{ name, as, filters? }]` — computed columns (`context.eval[]`). Each `as` grafts onto the row as an `unknown` key in `InferResponse`; shadowing a real column throws.",
    "  - `aggregate: { group?, eval?, sort?, paging? }` (with `returnType:\"aggregate\"`) builds `context.return.aggregate`. `group`/`eval` are `{ name, as, filters? }`, an aggregator like `sum`/`count` riding `filters`.",
    "    - ⚠ Write each `name` as a **bare** column (`\"status\"`). It is alias-qualified to `\"<alias>.status\"` on emit — the engine rejects an unqualified column in an aggregate with `Unsupported param format`. An already-dotted `name` (a `bind`ed/joined column) passes through.",
    "    - The alias it qualifies WITH is `tableAlias` when you set one, otherwise the table's name — and the statement DECLARES that alias (`dbo.as`) so the qualified name resolves. Nothing to do by hand; a bare `name` is the form to write.",
    "  - `sort: [{ sortBy: <col>, dir?: \"asc\"|\"desc\"|\"rand\" }]` and `paging: { page?, per_page?, offset?, totals?, metadata?, search?, sort? }` ride `context.return.list`.",
    "    - ⚠ `paging` with a page/per_page/offset field and `metadata` on (the DEFAULT) wraps the result in an envelope `{ items: Row[], curPage, nextPage, prevPage, offset, perPage, itemsReceived }` — plus `itemsTotal`/`pageTotal` when `totals: true` — instead of a bare `Row[]`. `InferResponse` reflects it. Pass `metadata: false` to keep the bare array.",
    "    - Read `nextPage` (`number|null`) as the typed has-next signal.",
    "    - **Input-bound paging:** `page`/`per_page`/`offset` also accept a `Value` (`inp(\"page\")`), riding `context.simpleExternal` while the static block stays the engine gate (`enabled:true`). `paging.search`/`sort` are `Value` dynamic overrides.",
    "    - A `search`/`sort`-only `paging` (no numeric field) does NOT paginate.",
    "  - `external: { value, permissions? }` — the classic whole-config blob (forces the gate on). It falls back to input-bound `paging` when it resolves empty, so supplying both is valid.",
    "  - `distinct` — `\"auto\"` (default) | `\"yes\"` | `\"no\"`, riding `context.return.<list|stream>.distinct`.",
    "- `s.db.truncate({ table, reset?, as? })` · `s.db.schema({ table, path, as? })`.",
    "- `s.db.direct_query({ sql, responseType?, args?, as? })` — `sql` is a **raw string** (not a `Value`); binds go in `args: Value[]`.",
    "- `s.db.transaction({ body })` — run a `Statement[]` atomically.",
    "- `s.db.bulk.add({ table, items, allowIdField?, as? })` / `s.db.bulk.update` / `s.db.bulk.patch` — `items` is an array `Value`.",
    "  - ⚠ `bulk.add` **drops `id` on every row unless `allowIdField: true`** (silently, next sequence value instead) — the opposite of `seed`, where `id` pins. Rows referenced by a foreign key need `allowIdField: true`; literal `items` carrying `id` without it throw. `bulk.update`/`patch` keep `id` (their match key).",
    "- `s.db.bulk.delete({ table, where?, as? })` — deletes rows by a `context.search` filter. `where` is the same surface as `s.db.query` (`expr(...)`/`cmp(...)`, `and(...)`/`or(...)` groups, an array of those ANDed, or a raw `Value`) and encodes through the identical `{expression:[…]}` search shape. ⚠ Omitting `where` deletes **every** row.",
    "",
    "Runtime behavior (what the `as:` output holds, and misses):",
    "",
    "- `db.get` binds **`null`** when no row matches (it does NOT throw) — so the output is `InferRow<typeof table> | null`; null-check it. On a hit it binds the **full row**. (`db.has` is the boolean existence test.)",
    "- `db.edit` binds the **full, post-mutation row** (the freshly-written values, not the pre-edit ones). `db.add` binds the **full inserted row**, including the auto-assigned `id` and `created_at`. So `InferRow<typeof table>` is the right response type for those two. `db.del` **binds `null`** — the engine deletes the row and returns no value, so don't return the `as` var expecting the deleted row.",
    "- Unlike `db.get`, `db.edit` and `db.del` **throw** `NotFound` (HTTP 404) when no row matches the field. `db.add` throws on a unique-constraint violation.",
    "- **`InferResponse<typeof query>`** derives an endpoint's response type (read-side round trip, no codegen). It resolves object-literal responses to those keys; a `response: ref(\"x\")` returning a variable bound by a TOP-LEVEL db op on a `table()` resolves to that op's result:",
    "  | statement | resolves to | on a miss |",
    "  |---|---|---|",
    "  | `db.add` / `db.edit` / `db.patch` / `db.add_or_edit` | `Row` (the full written row, non-nullable) | throws — `NotFound`/404 for `edit`/`patch`, a unique-constraint error for `add`; `add_or_edit` upserts and never misses |",
    "  | `db.get` | `Row \\| null` | binds `null` rather than throwing |",
    "  | `db.query` / `db.bulk.patch` | `Row[]` | — |",
    "  | `db.has` | `boolean` | — |",
    "  | `db.bulk.delete` | `number` (count) | — |",
    "  | `db.del`, `db.bulk.add`/`bulk.update`, raw `direct_query` | `unknown` (the engine leaves them untyped) | — |",
    "  - A `get`/`query` `output: [...]` selection narrows to a `Pick` (still `| null` for `get`). A dotted `ref(\"row.col\")` into a `db.get` row projects that column carrying the `| null` (→ `Col | null`).",
    "  - A value reshaped by a filter/lambda, or a variable built by control flow / `set_var` / a nested function, also resolves to `unknown`.",
    "  - Close any `unknown` by declaring `responseShape` on the query (`responseShape: null as InferRow<typeof t> | null`) — the declaration ALWAYS overrides derivation.",
    "  - ⚠ A `resultStrategy: \"replace\"` middleware attached `post` reshapes the endpoint's output at runtime, which the static walk cannot see. Declare `responseShape` when a post middleware rewrites the response.",
    "- **Addons** enrich returned rows. `db.query`/`get`/`add`/`edit`/`patch` accept `addon: [{ addon, as, input?, output?, children? }]`; `db.add_or_edit`/`del`/`has`/`truncate` take no `addon`.",
    "  - `addon` is the target (name or def handle). `as` is the destination on the row — a bare alias (`\"_user\"`) or a dotted `offset.alias`, authored relative to a row. Under a metadata paging envelope the `items[]` offset is prefixed automatically; writing it yourself is tolerated and not double-prefixed.",
    "  - `input` maps addon inputs — bind a parent-row column with `out(col)`. `output` restricts addon columns. `children` nests addons.",
    "  - An addon is a single table-bound db query, NOT a statement stack: `addon({ name, table, tableAlias?, where?, sort?, output: [cols], cardinality?: \"single\"|\"list\"|\"count\"|\"exists\"|\"aggregate\", group?, eval?, input?, context? })`, registered via `registerAddons([...])`.",
    "    - `table` auto-fills the `context.dbo` binding. ⚠ Never author `table: null` — that is a BROKEN table-less addon returning nothing; `codegen` emits it only for an already-broken pulled object.",
    "    - `tableAlias` is its SQL alias (`context.dbo.as`), qualifying `where`/`sort` columns (`col(\"merchant.id\")`).",
    "    - `where`/`sort` take the same surface as `s.db.query` and encode `context.search`/`context.sort`. `where` is the predicate binding the addon to the parent row — `expr(col(\"id\"), \"=\", inp(\"user_id\"))`.",
    "    - `cardinality` shapes the result (`context.return.type`, omitted for the `\"list\"` default). Rarer context (`eval`/`bind`/`lock`) stays raw `context` passthrough.",
    "  - Attaching a typed `addon({ table, output })` handle merges its alias (the last `as` segment) onto the row in `InferResponse`: `{cols}` for `single`, `{cols}[]` for `list`, `number` for `count`, `boolean` for `exists`, and for `aggregate` an array keyed by the `group`/`eval` aliases (`unknown` values; `unknown` when neither is declared).",
    "  - An attachment-level `output` narrows an object/array graft further. A bare-NAME reference grafts `unknown` — narrow it at the call site.",
    "  - ⚠ An alias that shadows an existing column on the queried table throws at build time; rename with a `_` prefix.",
    "- **Middleware attachment** runs a reusable `middleware({...})` before/after a host's own stack. Attach with the host's `middleware: { pre, post }` field on `query`/`function`/`task`/`tool`/`apiGroup` (NOT triggers): each phase is an ordered list of middleware refs (def handle or name), or `{ middleware, active: false }` to keep an entry disabled. Providing a phase **overrides** it (sets the stored `pre_customize`/`post_customize` flag); omitting a phase **inherits** the parent tier's chain — the engine resolves Query → API Group → Workspace at request time (override, not merge; the API-Group tier applies to queries — functions/tasks/tools have no API-group binding and inherit straight from the workspace). Prefer a def handle over a bare name when the middleware pins an explicit `guid`. `pre: middleware.clear()` (an empty list) overrides with nothing — stop inheriting. Workspace-level defaults are the terminal tier: `workspaceConfig({ middleware: { query: { pre }, function, task, tool } })` emits the flat `{host}_{phase}` map (no `_customize` flags) — setting it replaces the whole workspace map, so unlisted hosts are cleared; omit the field to leave existing workspace middleware untouched. Distinct from `s.middleware.call` (inline invoke).",
    "- **Middleware request context.** A `pre` middleware runs **after** auth resolution, so `auth()` is available inside the middleware when the host is authenticated (its `auth` names an auth table); on a public host `auth()` is `null`. This matters for the canonical use — a rate limit keyed by `auth(\"id\")`: on an authenticated endpoint the bucket is per-user, but attach the same middleware to a public endpoint and every anonymous caller keys under the same `null` id (one shared bucket), silently. To catch that, `export()` **warns** (never blocks) when a middleware whose stack references `auth()` is directly attached to a host where `auth()` may be null — a `query` with no auth table, a `task` (scheduled, never authenticated), or a `function`/`tool` (whose auth is caller-dependent). An authenticated query (its own `auth` table set) is skipped. The check is direct-attachment only; a middleware reaching a public query via API-group/workspace tier inheritance is not caught.",
    "- **Rate-limit recipe (the canonical middleware).** Per-user rate limiting is the most common middleware. Author it with `s.redis.ratelimit` and a **composite key** built via the filter chain — `\"prefix\" + auth(\"id\")` does not exist, you build the key: `middleware({ name: \"write_rl\", exceptionPolicy: \"rethrow\", stack: [ s.redis.ratelimit({ key: withFilters(c.text(\"rl:write:\"), fl.concat(auth(\"id\"))), max: c.int(10), ttl: c.int(30), error: c.text(\"Too fast.\") }) ] })`. `exceptionPolicy` defaults to `\"rethrow\"`, which is what makes a tripped limit abort with HTTP 429; `\"silent\"` would let the over-limit request through. Attach it with `middleware: { pre: [writeRl] }` on an **authenticated** host (its `auth` set) so `auth(\"id\")` keys per-user; on a public host `auth(\"id\")` is null and every caller shares one bucket (`export()` warns — see request context above). **Shared-bucket rule:** co-attaching one middleware object to N hosts means all N share the *same* key ⇒ *one* counter — `max: 10` is a global per-user budget across them, not 10-per-host. Vary the key (fold in the host/action name) for an independent limit per host.",
    "- **Middleware `exceptionPolicy`** governs what a **throw** in the middleware stack does to the request (SideStep passes the value through; the Xano engine interprets it). `\"rethrow\"` is the **default** — the throw aborts the request and surfaces the authored `error`/status (a tripped `s.redis.ratelimit` → HTTP 429); the `post` chain still runs. `\"silent\"` swallows the throw, so a guard set to it is **not enforced** — advisory middleware only. `\"critical\"` is `\"rethrow\"` plus skipping the `post` chain. The only difference between `rethrow` and `critical` is whether `post` runs — no status or logging change.",
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
    "- `s.api.request({ url?, method?, params?, headers?, timeout?, follow_location?, verify_host?, verify_peer?, ca_certificate?, certificate?, certificate_pass?, private_key?, private_key_pass?, description?, output?, as? })` — external HTTP request (`mvp:api_request`). Ergonomic types, each also accepting a dynamic `Value`: `method` suggests the 7 verbs (GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH), `params` a plain JSON object **or** a record whose values are tagged `Value`s (`{ count: ref(\"count\") }`, each lifted via a `set` filter — the same record-of-values shape `response: { key: value }` takes) (→ query string for GET/HEAD/OPTIONS, body otherwise), `headers` a `string[]` of full header lines, `timeout` a `number` in seconds (1–86400), and `follow_location`/`verify_host`/`verify_peer` booleans. `description` (Settings tab) and `output` filters (Output tab) ride the envelope. SSL cert interdependencies (certificate↔private_key, ca_certificate→verify_peer) are checked at build time when statically provable, else by the engine at runtime. The `as` result is typed as the `{request, response}` envelope (`response.status: number`, `response.result: unknown`), so `InferResponse` resolves a `ref` to it. Same typed result on `webflow.request` and `microservice.request`.",
    "- `s.stream.from_request({ url?, method?, …tls, as? })` — streaming external HTTP request (`mvp:streaming_api_request`); same typed field surface as `s.api.request` (no description/output envelope).",
    "- `s.webflow.request({ path?, method?, …tls, as? })` — Webflow API request (`mvp:connect_webflow_api_request`); like `s.api.request` but addressed by `path` (host is engine-supplied).",
    "- `s.task.call` / `s.tool.call` / `s.trigger.call` / `s.middleware.call` / `s.addon.call` — same `{ <target>, input?, as? }` shape against the named kind.",
    "",
    "Microservices (the `microservice()` def and the statement that calls it):",
    "",
    "- `s.microservice.request({ host, path, port?, method?, params?, headers?, timeout?, follow_location?, as? })` — in-cluster microservice call (`mvp:microservice_request`); no TLS fields. ONLY `host`+`path` required; the rest default to the engine's values (`GET`/`{}`/`[]`/`10`/`true`), always emitted. Pass the `microservice()` DEF as `host` — it binds by NAME (how the engine resolves it), so a rename fixes every call site and the port is checked before deploy. `port?` folds into `host` as `\"name:port\"`: a def exposing ONE `servicePort` resolves automatically, SEVERAL requires it. A raw `\"name:port\"` string works, unvalidated, and is the only way to reach an instance-level microservice. `tenantDeploy: \"manual\"` on the def imports the row without starting the workload.",
    "- `s.workflow_test.call({ workflowTest, datasource?, as? })` — run another workflow test from inside one. The odd one out: NO `input` (a workflow test takes none), and it carries `datasource?` instead — same clone caveat as the kind's own field.",
    "",
  );

  // Group by top-level namespace segment for readability. Legacy surfaces are
  // withheld here and named in the `## Legacy` index instead.
  //
  // A namespace whose statements are only meaningful in a particular HOST gets a
  // one-line note under its heading. The catalog is otherwise a flat list of
  // reachable surfaces, which reads as "callable anywhere" — true of nearly every
  // family, and wrong for the ones below.
  const groups = new Map<string, ManifestStatement[]>();
  for (const s of m.statements) {
    if (s.legacy) continue;
    const ns = s.sPath.includes(".") ? s.sPath.slice(0, s.sPath.indexOf(".")) : "(top-level)";
    (groups.get(ns) ?? groups.set(ns, []).get(ns)!).push(s);
  }
  for (const ns of [...groups.keys()].sort()) {
    lines.push(`### ${ns}`, "");
    const note = NAMESPACE_NOTES[ns];
    if (note) lines.push(note, "");
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
  if (legacyValues.length + legacyStatements.length + legacyFactories.length + SUPERSEDED_STATEMENTS.size + DECODE_ONLY_STATEMENTS.size > 0) {
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
    // Statements the engine WRITES but will not read back. Split from the
    // retired versions above because the instruction is the opposite one: a
    // retired version keeps running as stored and must be LEFT ALONE, while one
    // of these makes the workspace un-deployable and must be REPLACED.
    const decodeOnly = [...DECODE_ONLY_STATEMENTS.entries()];
    if (decodeOnly.length > 0) {
      lines.push("");
      lines.push(
        "Statements the engine writes but will NOT import back — no `s.` surface exists, and",
        "unlike the retired versions above these must be FIXED, not left alone. Pulled code shows",
        "them as `raw({ name: \"…\" })`; `export()` refuses any bundle that still contains one.",
        "",
      );
      for (const [stored, reason] of decodeOnly) lines.push(`- \`${stored}\` — ${reason}.`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
