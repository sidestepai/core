/**
 * Per-kind decoders — stored object envelope → an authoring def literal.
 *
 * Each kind is declared as a table of `{ def, stored, fallback }` entries that
 * mirrors its encoder one key at a time, plus the handful of shared blocks that
 * need real inversion (tags, history, middleware, inputs, response, stack). A key
 * whose stored value equals what the encoder writes by default is **elided**,
 * which is most of what makes generated defs readable (KTD-4). Elision is safe
 * by construction here: it is derived from the encoder's own default, not from a
 * per-field judgement call, and the whole-workspace round trip proves it.
 *
 * Each kind names the `factory` its def literal is wrapped in — `table(…)`,
 * `defineFunction(…)`, and so on. This is not cosmetic. The def *types* carry
 * their parameters as phantom optional props, so a bare `{…} satisfies TableDef`
 * binds `TableDef<string, unknown>` and every downstream inference degrades with
 * it: `ColsOf` collapses to `string` (no column checking on `fieldName`/`output`/
 * `sortBy`), `InferInput` loses a query's branded payload, and an agent's output
 * schema stops typing `s.ai.agent.run`. The factories declare `const` parameters
 * that recover all of it, and `examples/sandbox` already authors this way — so a
 * factory call is both better-typed and the shape the docs teach.
 *
 * A kind with no `factory` falls back to `… satisfies <defType>`. That is the
 * escape hatch for kinds whose factory takes a *different* shape than the def it
 * returns and cannot be inverted faithfully.
 */
import type { DecodeContext } from "../context.js";
import { CORE_MODULE } from "../context.js";
import { arr, id, lit, obj, type Expr } from "../print.js";
import type { RefIndex, ResolveOptions } from "../ref-index.js";
import { resolveReference } from "../ref-index.js";
import { decodeFieldMap, decodeResponse, deepEqual } from "../field.js";
import { decodeStack } from "../statement.js";
import { decodeCondition } from "../expression.js";
import { isDefaultEnvelopeMember, isEmptyOutput } from "../../validate/normalize.js";

/** One `key: value` pair of a generated def literal. */
export type DefEntry = readonly [string, Expr];

/** A stored object as read from a bundle payload array. */
export type StoredObject = Record<string, unknown>;

/** Everything a kind decoder needs beyond the object itself. */
export interface KindDecodeArgs {
  readonly ctx: DecodeContext;
  readonly refs: RefIndex;
  readonly stored: StoredObject;
  readonly resolve: ResolveOptions;
}

/** A registered kind decoder. */
export interface KindDecoder {
  /** Kind name, matching the encode-side registry. */
  readonly name: string;
  /** Payload array the kind lands in. */
  readonly payloadKey: string;
  /** Directory the generated file goes in. */
  readonly dir: string;
  /** The `Xano.register*` method the barrel calls. */
  readonly register: string;
  /** The exported def type, imported `type`-only when there is no {@link factory}. */
  readonly defType: string;
  /**
   * The exported factory the def literal is wrapped in, imported as a value.
   * Omitted for kinds that still fall back to `satisfies` (see the module header).
   */
  readonly factory?: string;
  /** Build the def literal's entries. */
  decode(args: KindDecodeArgs): DefEntry[];
}

// --- shared inverses ---------------------------------------------------------

/** Emit `key: <stored>` unless the stored value is the encoder's default. */
function plain(stored: StoredObject, storedKey: string, fallback: unknown, defKey = storedKey) {
  const value = stored[storedKey];
  if (value === undefined || deepEqual(value, fallback)) return null;
  return [defKey, lit(value)] as DefEntry;
}

/**
 * Emit `key: <stored>` whenever the key is **present**, with no default to
 * compare against.
 *
 * The inverse of a presence-preserving encoder. For a `?=`-optional block, "the
 * stored value equals the default" and "the key is absent" are different bytes,
 * and eliding on value would collapse them — so the lean shape Xano's editor
 * writes and the explicit shape an author asks for each round-trip to their own.
 */
function present(stored: StoredObject, storedKey: string, defKey = storedKey): DefEntry | null {
  const value = stored[storedKey];
  return value === undefined ? null : [defKey, lit(value)];
}

/** `tag: [{tag}]` → `tags: ["…"]`, elided when empty. */
function tags(stored: StoredObject): DefEntry | null {
  const value = stored.tag;
  if (!Array.isArray(value) || value.length === 0) return null;
  return ["tags", lit(value.map((t) => (t as { tag: string }).tag))];
}

/** Object types whose request-history default is OFF (mirrors `common.ts`). */
const HISTORY_DEFAULT_OFF = new Set(["function", "middleware", "trigger"]);

/**
 * `{inherit, enabled, limit}` → the scalar authoring surface, elided when it is
 * the kind's inherit default. Returns `undefined` for a stored block no scalar
 * produces (e.g. disabled with a custom limit), so the caller can report it.
 */
function historyScalar(objType: string, block: unknown): boolean | number | "all" | null | undefined {
  const value = block as { inherit?: boolean; enabled?: boolean; limit?: number } | undefined;
  if (value === undefined) return null;
  const isDefault =
    value.inherit === true &&
    value.enabled === !HISTORY_DEFAULT_OFF.has(objType) &&
    value.limit === 100;
  if (isDefault) return null;
  if (value.inherit !== false) return undefined;
  if (value.enabled === false) return value.limit === 100 ? false : undefined;
  if (value.limit === -1) return "all";
  if (value.limit === 100) return true;
  return typeof value.limit === "number" && value.limit >= 0 ? value.limit : undefined;
}

/** `history:` for an object-tier kind. */
function history(args: KindDecodeArgs, objType: string): DefEntry | null {
  const scalar = historyScalar(objType, args.stored.history);
  if (scalar === null) return null;
  if (scalar === undefined) {
    args.ctx.problem(
      "verify-mismatch",
      `history block ${JSON.stringify(args.stored.history)} has no scalar authoring form`,
    );
    return null;
  }
  return ["history", lit(scalar)];
}

/** `history:` for a container-tier kind (`app` uses `query_*`, toolsets `tool_*`). */
function containerHistory(args: KindDecodeArgs, prefix: "query" | "tool"): DefEntry | null {
  const block = args.stored.history as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const normalized = {
    inherit: block.inherit,
    enabled: block[`${prefix}_enabled`],
    limit: block[`${prefix}_limit`],
  };
  // Both container tiers default ON, so the inherit default is the same shape.
  if (deepEqual(normalized, { inherit: true, enabled: true, limit: 100 })) return null;
  const scalar = historyScalar("query", normalized);
  if (scalar === null) return null;
  if (scalar === undefined) {
    args.ctx.problem(
      "verify-mismatch",
      `${prefix} history block ${JSON.stringify(block)} has no scalar authoring form`,
    );
    return null;
  }
  return ["history", lit(scalar)];
}

/** One stored `mvp:middleware` attachment → its authoring entry. */
function middlewareEntry(args: KindDecodeArgs, entry: unknown): Expr {
  const guid = (entry as { context?: { middleware?: { id?: unknown } } })?.context?.middleware?.id;
  const disabled = (entry as { disabled?: boolean }).disabled === true;
  const ref =
    typeof guid === "string"
      ? resolveReference(args.ctx, args.refs, guid, {
          ...args.resolve,
          unresolved: "object-ref",
        })
      : lit(guid);
  // `active: false` is the only non-ObjectRef authoring form, so a plain
  // attachment stays a bare reference.
  return disabled
    ? obj([
        ["middleware", ref],
        ["active", lit(false)],
      ])
    : ref;
}

/** `middleware: {pre, post}`, elided when the block is the empty default. */
function middleware(args: KindDecodeArgs): DefEntry | null {
  const block = args.stored.middleware as
    | { pre_customize?: boolean; post_customize?: boolean; pre?: unknown[]; post?: unknown[] }
    | undefined;
  if (block === undefined) return null;
  const entries: DefEntry[] = [];
  // `pre_customize` is what distinguishes "authored an empty list" from "did not
  // author this phase at all", so it drives emission rather than list length.
  if (block.pre_customize) {
    entries.push(["pre", arr((block.pre ?? []).map((e) => middlewareEntry(args, e)))]);
  }
  if (block.post_customize) {
    entries.push(["post", arr((block.post ?? []).map((e) => middlewareEntry(args, e)))]);
  }
  return entries.length > 0 ? ["middleware", obj(entries)] : null;
}

/** `input: {…}`, elided when the object declares none. */
function inputs(args: KindDecodeArgs): DefEntry | null {
  const stored = args.stored.input;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  args.ctx.use(CORE_MODULE, "input");
  return ["input", decodeFieldMap(args.ctx, args.refs, stored as never, "input", args.resolve)];
}

/** `response:`, elided when the object declares none. */
function response(args: KindDecodeArgs): DefEntry | null {
  const stored = args.stored.result;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  const expr = decodeResponse(args.ctx, stored as never);
  return expr ? ["response", expr] : null;
}

/**
 * `stack: […]`, elided when empty.
 *
 * Only kinds that carry a statement stack call this, so "no `run`" here means an
 * object that should have had a body and did not. That is *not* an error — a
 * workspace can legitimately hold an endpoint someone created and never filled
 * in, and this decode is faithful. But the generated file is then a bare
 * `{name, guid, verb, apiGroup}`, which looks exactly like a decoder that gave
 * up, and the round trip is clean either way. Reporting it is the only thing
 * that tells the two apart without going and reading the workspace.
 */
function stack(args: KindDecodeArgs): DefEntry | null {
  const run = args.stored.run;
  if (!Array.isArray(run) || run.length === 0) {
    args.ctx.problem("empty-source", "no statements in the source object — emitted without a `stack`");
    return null;
  }
  return ["stack", decodeStack(args.ctx, args.refs, run, args.resolve)];
}

/** `name` and `guid` lead every def; the guid is preserved verbatim (KTD-7). */
function identity(args: KindDecodeArgs): DefEntry[] {
  const entries: DefEntry[] = [["name", lit(args.stored.name)]];
  // Emitted even when it happens to equal md5(type:name): a pulled object's guid
  // is the engine's, and re-deriving it would be a silent identity rewrite.
  if (typeof args.stored.guid === "string" && args.stored.guid !== "") {
    entries.push(["guid", lit(args.stored.guid)]);
  }
  return entries;
}

/** Drop the nulls a table of optional entries produces. */
function compact(entries: Array<DefEntry | null>): DefEntry[] {
  return entries.filter((e): e is DefEntry => e !== null);
}

// --- table sub-structures ----------------------------------------------------

/** Stored index → `IndexDef`, dropping the keys `encodeIndex` fills. */
function indexes(args: KindDecodeArgs): DefEntry | null {
  const stored = args.stored.index;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "index",
    arr(
      stored.map((entry) => {
        const index = entry as { name?: string; lang?: string; type: string; fields: unknown[] };
        return obj(
          compact([
            ["type", lit(index.type)] as DefEntry,
            [
              "fields",
              arr(
                (index.fields ?? []).map((field) => {
                  const { name, op } = field as { name: string; op?: string };
                  return obj(compact([["name", lit(name)] as DefEntry, op ? (["op", lit(op)] as DefEntry) : null]));
                }),
              ),
            ] as DefEntry,
            index.name ? (["name", lit(index.name)] as DefEntry) : null,
            index.lang ? (["lang", lit(index.lang)] as DefEntry) : null,
          ]),
        );
      }),
    ),
  ];
}

/**
 * Stored view → `ViewDef`.
 *
 * A view's `expression` is the same `{expression: […]}` boolean tree every other
 * filter surface uses (`encodeView` builds it through `encodeComparison`), so it
 * inverts through the shared algebra rather than needing one of its own. A tree
 * that will not decode is reported instead of dropped — silently losing a view's
 * filter would widen what the view returns, which is a data-exposure change, not
 * a cosmetic one.
 */
function views(args: KindDecodeArgs): DefEntry | null {
  const stored = args.stored.views;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "views",
    arr(
      stored.map((entry) => {
        const view = entry as {
          name: string;
          id: string;
          alias?: string;
          hiddenCols?: string[];
          q?: string;
          expression?: unknown[];
          sort?: unknown[];
        };
        let where: DefEntry | null = null;
        if (Array.isArray(view.expression) && view.expression.length > 0) {
          const condition = args.ctx.speculate(() =>
            decodeCondition(args.ctx, { expression: view.expression }),
          );
          if (condition) {
            where = ["where", condition.expr];
          } else {
            args.ctx.problem(
              "verify-mismatch",
              `table view "${view.name}" has a filter expression this decoder could not invert; the generated view would return more rows than the original`,
            );
          }
        }
        return obj(
          compact([
            ["name", lit(view.name)] as DefEntry,
            ["id", lit(view.id)] as DefEntry,
            view.alias ? (["alias", lit(view.alias)] as DefEntry) : null,
            view.hiddenCols?.length ? (["hide", lit(view.hiddenCols)] as DefEntry) : null,
            view.q ? (["q", lit(view.q)] as DefEntry) : null,
            where,
            view.sort?.length ? (["sort", lit(view.sort)] as DefEntry) : null,
          ]),
        );
      }),
    ),
  ];
}

// --- the twelve kinds --------------------------------------------------------

const EMPTY_EXTERNAL = { source: "", id: "" };

/**
 * Function/query `cache` default. A function's is hard-coded by the encoder, so
 * only a query can author it.
 */
const DEFAULT_CACHE = {
  active: false,
  ttl: 3600,
  input: true,
  auth: true,
  datasource: true,
  ip: false,
  headers: [],
  env: [],
};

export const KIND_DECODERS: readonly KindDecoder[] = [
  {
    name: "table",
    payloadKey: "dbo",
    dir: "tables",
    register: "registerTables",
    defType: "TableDef",
    factory: "table",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "auth", false),
        plain(a.stored, "install", false),
        // The generated schema and index arrays are complete, so the encoder's
        // system-column/index injection must stay out of the way — otherwise it
        // re-prepends what is already there and the round trip drifts.
        ["system", lit(false)],
        [
          "schema",
          decodeFieldMap(a.ctx, a.refs, (a.stored.schema ?? []) as never, "f", a.resolve),
        ],
        indexes(a),
        views(a),
        Array.isArray(a.stored.autocomplete) && a.stored.autocomplete.length > 0
          ? ["autocomplete", lit(a.stored.autocomplete.map((e) => (e as { name: string }).name))]
          : null,
        plain(a.stored, "external", EMPTY_EXTERNAL),
        plain(a.stored, "use_xdo", false, "useXdo"),
        tags(a.stored),
      ]),
  },
  {
    name: "function",
    payloadKey: "function",
    dir: "functions",
    register: "registerFunctions",
    defType: "FunctionDef",
    factory: "defineFunction",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain((a.stored.workspace ?? {}) as StoredObject, "id", 0, "workspace"),
        history(a, "function"),
        middleware(a),
        tags(a.stored),
        inputs(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "query",
    payloadKey: "query",
    dir: "queries",
    register: "registerQueries",
    defType: "QueryDef",
    factory: "query",
    decode: (a) =>
      compact([
        ...identity(a),
        ["verb", lit(a.stored.verb)],
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "api_enabled", true, "apiEnabled"),
        authRef(a, a.stored.auth),
        plain(a.stored, "response_type", "standard", "responseType"),
        plain(a.stored, "disabled", false),
        apiGroupBinding(a),
        plain(a.stored, "cache", DEFAULT_CACHE),
        middleware(a),
        tags(a.stored),
        history(a, "query"),
        inputs(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "api_group",
    payloadKey: "app",
    dir: "apiGroups",
    register: "registerApiGroups",
    defType: "ApiGroupDef",
    factory: "apiGroup",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "canonical", ""),
        plain(a.stored, "swagger", false),
        plain(a.stored, "api_group_enabled", true, "apiGroupEnabled"),
        plain(a.stored, "docs", ""),
        plain(a.stored, "documentation", { require_token: false, token: "" }),
        middleware(a),
        containerHistory(a, "query"),
        tags(a.stored),
        cors(a),
      ]),
  },
  {
    name: "trigger",
    payloadKey: "trigger",
    dir: "triggers",
    register: "registerTriggers",
    defType: "TriggerDef",
    decode: (a) =>
      compact([
        ...identity(a),
        ["objType", lit(a.stored.obj_type)],
        plain(a.stored, "active", true),
        plain(a.stored, "description", ""),
        plain(a.stored, "obj_id", 0, "objId"),
        history(a, "trigger"),
        ["meta", lit(a.stored.meta)],
        tags(a.stored),
        // `input` is implied by trigger type and re-injected by the encoder, so
        // it is deliberately not carried. `hasResult` is required on `TriggerDef`
        // (it selects the result envelope), so it is always stated.
        ["hasResult", lit(Array.isArray(a.stored.result) && a.stored.result.length > 0)],
        response(a),
        stack(a),
      ]),
  },
  {
    name: "task",
    payloadKey: "task",
    dir: "tasks",
    register: "registerTasks",
    defType: "TaskDef",
    factory: "task",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "datasource", ""),
        plain(a.stored, "active", false),
        middleware(a),
        tags(a.stored),
        history(a, "task"),
        schedule(a),
        stack(a),
      ]),
  },
  {
    name: "middleware",
    payloadKey: "middleware",
    dir: "middleware",
    register: "registerMiddleware",
    defType: "MiddlewareDef",
    factory: "middleware",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "result_type", "merge", "resultStrategy"),
        plain(a.stored, "exception", "silent", "exceptionPolicy"),
        history(a, "middleware"),
        tags(a.stored),
        inputs(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "addon",
    payloadKey: "addon",
    dir: "addons",
    register: "registerAddons",
    defType: "AddonDef",
    factory: "addon",
    decode: (a) => addonEntries(a),
  },
  {
    name: "tool",
    payloadKey: "tool",
    dir: "ai",
    register: "registerTools",
    defType: "ToolDef",
    factory: "tool",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "instructions", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "enabled", true),
        middleware(a),
        tags(a.stored),
        history(a, "tool"),
        plain((a.stored.toolset ?? {}) as StoredObject, "id", 0, "toolsetId"),
        inputs(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "mcp_server",
    payloadKey: "toolset",
    dir: "ai",
    register: "registerMcpServers",
    defType: "McpServerDef",
    factory: "mcpServer",
    decode: (a) => toolsetBaseEntries(a),
  },
  {
    name: "agent",
    payloadKey: "toolset",
    dir: "ai",
    register: "registerAgents",
    defType: "AgentDef",
    factory: "agent",
    decode: (a) => [...toolsetBaseEntries(a), ...agentSettingsEntries(a)],
  },
  {
    name: "workspace",
    payloadKey: "workspace",
    dir: ".",
    register: "registerWorkspace",
    defType: "WorkspaceConfigDef",
    factory: "workspaceConfig",
    decode: (a) =>
      compact([
        // Workspace-config is a singleton whose guid the export path derives from
        // the workspace name, and `WorkspaceConfigDef` declares no `guid` field —
        // the one KTD-7 exemption.
        ["name", lit(a.stored.name)],
        plain(a.stored, "description", ""),
        plain(a.stored, "canonical", ""),
        plain(a.stored, "use_xdo", false),
        plain(a.stored, "preferences", {}),
        (a.stored.realtime as { canonical?: string })?.canonical
          ? (["realtime", lit(a.stored.realtime)] as DefEntry)
          : null,
        workspaceMiddleware(a),
        workspaceHistory(a),
        workspaceEnv(a),
        plain(a.stored, "settings", {}),
        // `?=`-optional in the engine schema, so decoded by presence rather than
        // by comparing against a default (see `present`).
        present(a.stored, "use_custom_names"),
        present(a.stored, "defaults"),
        present(a.stored, "datasources"),
        present(a.stored, "datasource_live"),
      ]),
  },
];

/**
 * An auth-table reference (`query.auth`, `tool[].auth`).
 *
 * The stored form in a bundle is the auth table's **guid**, and this is the one
 * place where emitting it verbatim is actively dangerous rather than merely
 * unreadable: `resolveAuthRef` reads a bare string as a table *name* and derives
 * `md5("dbo:<that string>")` from it — silently repointing the endpoint at a
 * table that does not exist, with no error at export and no error at import.
 * Resolving through {@link resolveReference} with `unresolved: "object-ref"`
 * keeps the guid a guid.
 *
 * `false` (no auth) and the numeric `dbo.id` escape hatch pass through as-is.
 */
function authRef(a: KindDecodeArgs, stored: unknown): DefEntry | null {
  if (stored === undefined || stored === false) return null;
  if (typeof stored === "number") return ["auth", lit(stored)];
  if (typeof stored !== "string" || stored === "") return null;
  return [
    "auth",
    resolveReference(a.ctx, a.refs, stored, { ...a.resolve, unresolved: "object-ref" }),
  ];
}

/** A query's api-group binding: a guid reference, or the numeric escape hatch. */
function apiGroupBinding(a: KindDecodeArgs): DefEntry | null {
  const id = (a.stored.app as { id?: unknown } | undefined)?.id;
  if (id === undefined || id === 0) return null;
  if (typeof id === "number") return ["apiGroupId", lit(id)];
  return [
    "apiGroup",
    resolveReference(a.ctx, a.refs, String(id), { ...a.resolve, unresolved: "object-ref" }),
  ];
}

/** An api group's CORS block, elided when it is the encoder default. */
function cors(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.cors as Record<string, unknown> | undefined;
  if (stored === undefined) return null;
  const isDefault =
    deepEqual(stored, {
      mode: "default",
      allowOrigins: [],
      allowHeaders: [],
      allowCredentials: false,
      maxAge: 0,
      allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false },
    });
  return isDefault ? null : ["cors", lit(stored)];
}

/** A task's schedule list, inverting `encodeSchedule`. */
function schedule(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.schedule;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "schedule",
    arr(
      stored.map((entry) => {
        const s = entry as {
          starts_on: unknown;
          repeat?: { enabled?: boolean; freq?: number; ends?: { enabled?: boolean; on?: unknown } };
        };
        const repeat = s.repeat ?? {};
        return obj(
          compact([
            ["startsOn", lit(s.starts_on)] as DefEntry,
            // `freq` is never elided: `repeatEnabled` derives from `freq != null`,
            // so dropping it at its default would silently flip `repeat.enabled`.
            repeat.freq !== undefined ? (["freq", lit(repeat.freq)] as DefEntry) : null,
            repeat.ends?.enabled ? (["endsOn", lit(repeat.ends.on)] as DefEntry) : null,
            // Stated only when the stored flag disagrees with that derivation.
            repeat.enabled !== (repeat.freq !== undefined)
              ? (["repeatEnabled", lit(repeat.enabled ?? false)] as DefEntry)
              : null,
          ]),
        );
      }),
    ),
  ];
}

/** Object types the workspace-tier history map carries a pair for. */
const WORKSPACE_HISTORY_TYPES = [
  "query",
  "function",
  "task",
  "tool",
  "trigger",
  "middleware",
] as const;

/**
 * The workspace tier's flat 12-key history map → the author's per-type scalars.
 *
 * `buildWorkspaceHistory` writes every type wholesale, filling absent ones with
 * their engine default, so a type sitting at its default is safely omitted here.
 * Presence of the block itself is significant, though — the encoder emits the key
 * only when the author set one — so an all-default map still emits `history: {}`.
 */
function workspaceHistory(a: KindDecodeArgs): DefEntry | null {
  const block = a.stored.history as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const entries: DefEntry[] = [];
  for (const type of WORKSPACE_HISTORY_TYPES) {
    const enabled = block[`${type}_enabled`];
    const limit = block[`${type}_limit`];
    if (enabled === undefined && limit === undefined) continue;
    if (enabled === !HISTORY_DEFAULT_OFF.has(type) && limit === 100) continue;
    // No `inherit` at this tier — it is the terminal fallback — so the scalar
    // inverse is fed a synthetic `inherit: false`.
    const scalar = historyScalar(type, { inherit: false, enabled, limit });
    if (scalar === undefined) {
      a.ctx.problem(
        "verify-mismatch",
        `workspace ${type} history {enabled: ${String(enabled)}, limit: ${String(limit)}} has no scalar authoring form`,
      );
      continue;
    }
    if (scalar !== null) entries.push([type, lit(scalar)]);
  }
  return ["history", obj(entries)];
}

/** Per-host middleware phases the workspace tier stores as a flat 8-key map. */
const WORKSPACE_MIDDLEWARE_HOSTS = ["function", "query", "task", "tool"] as const;

/**
 * The workspace tier's flat `{host}_{phase}` middleware map → the author's
 * nested per-host shape. Like history, the block's presence is significant, so an
 * all-empty map still emits `middleware: {}`.
 */
function workspaceMiddleware(a: KindDecodeArgs): DefEntry | null {
  const block = a.stored.middleware as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const hosts: DefEntry[] = [];
  for (const host of WORKSPACE_MIDDLEWARE_HOSTS) {
    const phases: DefEntry[] = [];
    for (const phase of ["pre", "post"] as const) {
      const list = block[`${host}_${phase}`];
      if (!Array.isArray(list) || list.length === 0) continue;
      phases.push([phase, arr(list.map((e) => middlewareEntry(a, e)))]);
    }
    if (phases.length > 0) hosts.push([host, obj(phases)]);
  }
  return ["middleware", obj(hosts)];
}

/**
 * Workspace env vars: stored `env[]` → the author's name→value map.
 *
 * These are hoisted to the bundle's **top-level** `payload.env` on export, not
 * kept on the workspace object, so `decodeBundle` folds them back in before
 * calling this.
 */
function workspaceEnv(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.env;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "env",
    obj(stored.map((e) => [(e as { name: string }).name, lit((e as { value: string }).value)])),
  ];
}

/** Cardinalities `buildContext` can rebuild from `cardinality:` alone. */
const LIFTABLE_CARDINALITY = new Set(["single", "count", "exists"]);

/**
 * `context.return` → `cardinality:`, plus whether the block is fully expressed.
 *
 * `"list"` is the engine default and `buildContext` omits it, so it is never
 * emitted. `"aggregate"` is deliberately excluded: its graft type is derived from
 * `group`/`eval`, which this inverse does not recover, so lifting it would type
 * one shape while the passthrough encodes another.
 */
function addonCardinality(block: unknown): { value: string; whole: boolean } | null {
  if (block === null || typeof block !== "object") return null;
  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string" || !LIFTABLE_CARDINALITY.has(type)) return null;
  // A bare `{type}` is exactly what `buildContext` writes, so it can be dropped.
  // The engine writes the full envelope, which has to ride through `context` —
  // stating `cardinality` alongside it is still correct (an explicit `return`
  // wins on encode, and `buildContext` only rejects a *conflicting* type), and
  // it is what gives the generated addon its graft type.
  return { value: type, whole: Object.keys(block as object).length === 1 };
}

/** `[{sortBy, orderBy}]` → the authoring `[{sortBy, dir?}]` form (mirrors `db.query`'s). */
function addonSort(list: unknown): Expr | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const rows: Expr[] = [];
  for (const raw of list) {
    const sortBy = (raw as { sortBy?: unknown }).sortBy;
    const orderBy = (raw as { orderBy?: unknown }).orderBy;
    if (typeof sortBy !== "string") return null;
    const cells: Array<[string, Expr]> = [["sortBy", lit(sortBy)]];
    // `asc` is the encoder's default, so stating it would be noise.
    if (typeof orderBy === "string" && orderBy !== "asc") cells.push(["dir", lit(orderBy)]);
    rows.push(obj(cells));
  }
  return arr(rows);
}

/** `{customize:true, items:[{name}]}` → the `["id","name"]` column list. */
function addonOutput(stored: unknown): Expr | null {
  if (stored === null || typeof stored !== "object") return null;
  const block = stored as { customize?: unknown; items?: unknown };
  if (block.customize !== true || !Array.isArray(block.items)) return null;
  const names: string[] = [];
  for (const item of block.items) {
    const name = (item as { name?: unknown; children?: unknown }).name;
    // A nested selection has no column-list form; `children: []` is the engine's
    // filler and `normalize` drops it, so only a populated one disqualifies.
    const children = (item as { children?: unknown }).children;
    if (typeof name !== "string") return null;
    if (Array.isArray(children) && children.length > 0) return null;
    names.push(name);
  }
  return lit(names);
}

/**
 * An addon's def entries — the inverse of `buildContext`.
 *
 * An addon persists as one `context` blob, and passing it through verbatim was
 * exact but unreadable: a pulled addon arrived as sixty lines of engine defaults
 * with the table binding buried as a guid. Each authoring surface it can rebuild
 * (`table`, `where`, `sort`, `cardinality`, `output`) is lifted back out, and
 * whatever is left still rides through `context` so nothing is lost. A lifted key
 * is removed from that passthrough — `buildContext` lets an explicit `context`
 * win, so leaving both would silently ignore the readable one.
 */
function addonEntries(a: KindDecodeArgs): DefEntry[] {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const dbo = context.dbo as Record<string, unknown> | undefined;
  const dboId = typeof dbo?.id === "string" ? dbo.id : "";
  const consumed = new Set<string>();

  // The engine persists `{as, id}`; `buildContext` writes `{id}` alone. Both are
  // the same bytes once `normalize` drops the empty alias, so bind on either —
  // but a *populated* alias has no `table:` form and must ride through `context`,
  // and an empty `{as:"", id:""}` binds nothing at all (`resolveRef` rejects a
  // target with neither name nor guid, so emitting `table:` would be a hard
  // failure rather than a readability loss).
  const onlyBindingKeys =
    dbo !== undefined && Object.keys(dbo).every((key) => key === "id" || key === "as");
  const bindsTable = dboId !== "" && onlyBindingKeys && (dbo!.as ?? "") === "";
  // An empty `{as:"", id:""}` is the engine's *unbound* binding — what an addon
  // stores before a table is chosen, and what it falls back to when the table it
  // referenced is deleted (the engine clears the id rather than leaving a
  // tombstone, so those two are the same bytes). `table: null` says exactly that,
  // and re-encodes to the same empty binding; the alternative was leaking the raw
  // `context.dbo` blob, which documents nothing.
  const unbound =
    !bindsTable && onlyBindingKeys && dboId === "" && (dbo!.as ?? "") === "";
  if (bindsTable || unbound) consumed.add("dbo");

  const where = decodeCondition(a.ctx, context.search);
  if (where) consumed.add("search");

  const sort = addonSort(context.sort);
  if (sort) consumed.add("sort");

  const cardinality = addonCardinality(context.return);
  if (cardinality?.whole) consumed.add("return");

  const output = addonOutput(a.stored.output);

  // Whatever no authoring surface claimed. `buildContext` spreads `def.context`
  // first and only auto-fills what it does not already carry, so a rich engine
  // context (bind/eval/lock/future) survives untouched — whereas hoisting those
  // keys would silently drop every one the authoring surface cannot declare.
  //
  // Members sitting at their engine default are dropped, which is what makes an
  // unbound addon readable at all: the engine writes the whole
  // bind/eval/lock/return/external/simpleExternal envelope even when nothing is
  // customized. Safe by construction, and deliberately keyed on `normalize`'s own
  // oracle rather than a second list — it already elides these on BOTH sides of
  // the round-trip comparison, so a dropped member cannot change the verdict.
  const passthrough = Object.fromEntries(
    Object.entries(context).filter(
      ([key, value]) => !consumed.has(key) && !isDefaultEnvelopeMember(key, value),
    ),
  );

  return compact([
    ...identity(a),
    plain(a.stored, "description", ""),
    bindsTable
      ? ([
          "table",
          resolveReference(a.ctx, a.refs, dboId, { ...a.resolve, unresolved: "object-ref" }),
        ] as DefEntry)
      : unbound
        ? (["table", lit(null)] as DefEntry)
        : null,
    inputs(a),
    where ? (["where", where.expr] as DefEntry) : null,
    sort ? (["sort", sort] as DefEntry) : null,
    output
      ? (["output", output] as DefEntry)
      : // `{items:[],customize:false}` is "no selection", which `buildOutput`
        // rebuilds from an absent `output` — and `normalize` already elides on
        // both sides, so dropping it cannot change the round trip.
        a.stored.output === undefined || isEmptyOutput(a.stored.output)
        ? null
        : (["output", lit(a.stored.output)] as DefEntry),
    cardinality ? (["cardinality", lit(cardinality.value)] as DefEntry) : null,
    Object.keys(passthrough).length > 0 ? (["context", lit(passthrough)] as DefEntry) : null,
    tags(a.stored),
  ]);
}

/** The shared toolset envelope both mcp-server and agent carry. */
function toolsetBaseEntries(a: KindDecodeArgs): DefEntry[] {
  return compact([
    ...identity(a),
    plain(a.stored, "description", ""),
    plain(a.stored, "instructions", ""),
    plain(a.stored, "docs", ""),
    plain(a.stored, "enabled", true),
    plain(a.stored, "canonical", ""),
    plain(a.stored, "spec", ""),
    containerHistory(a, "tool"),
    tags(a.stored),
    toolRefs(a),
  ]);
}

/** A toolset's `tool[]` refs, inverting `encodeToolRefs`. */
function toolRefs(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.tool;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "tools",
    arr(
      stored.map((entry) => {
        const t = entry as { id: unknown; enabled?: boolean; auth?: unknown };
        return obj(
          compact([
            typeof t.id === "string"
              ? ([
                  "tool",
                  resolveReference(a.ctx, a.refs, t.id, {
                    ...a.resolve,
                    unresolved: "object-ref",
                  }),
                ] as DefEntry)
              : (["id", lit(t.id)] as DefEntry),
            t.enabled === false ? (["enabled", lit(false)] as DefEntry) : null,
            // Same hazard as a query's `auth`: a bare guid string here is read
            // as a table NAME and re-derived into a different guid.
            authRef(a, t.auth),
          ]),
        );
      }),
    ),
  ];
}


/**
 * The stored provider config's wire keys → the `llm` authoring keys.
 *
 * The two disagree in more than casing — `useSearchGrounding` is authored as
 * `searchGrounding`, `dynamicRetrievalConfig` as `dynamicRetrieval` — and the
 * thinking blocks are nested on the wire but flat in the authoring surface. A
 * blind spread produces a def that still re-encodes to the right bytes (the
 * renamed keys are simply ignored and their defaults re-emitted) while failing
 * to type-check, which is why the generated tree is type-checked and not only
 * round-tripped.
 */
const PROVIDER_CONFIG_KEYS: ReadonlyArray<readonly [string, string, unknown]> = [
  ["apiKey", "apiKey", ""],
  ["model", "model", ""],
  ["temperature", "temperature", 1],
  ["sendReasoning", "sendReasoning", true],
  ["reasoningEffort", "reasoningEffort", "medium"],
  ["organization", "organization", ""],
  ["project", "project", ""],
  ["compatibility", "compatibility", "strict"],
  ["useSearchGrounding", "searchGrounding", false],
  ["baseURL", "baseURL", ""],
  ["headers", "headers", ""],
  ["safetySettings", "safetySettings", ""],
  ["dynamicRetrievalConfig", "dynamicRetrieval", ""],
];

/** Flatten a stored provider config into `llm` authoring entries. */
function providerConfigEntries(config: Record<string, unknown>): DefEntry[] {
  const entries: DefEntry[] = [];
  for (const [storedKey, defKey, fallback] of PROVIDER_CONFIG_KEYS) {
    if (!Object.hasOwn(config, storedKey)) continue;
    const value = config[storedKey];
    if (deepEqual(value, fallback)) continue;
    entries.push([defKey, lit(value)]);
  }

  // Anthropic nests its thinking budget behind an enabled/disabled discriminator;
  // the authoring surface is a single optional token count.
  const thinking = config.thinking as { type?: string; budgetTokens?: unknown } | undefined;
  if (thinking?.type === "enabled" && thinking.budgetTokens !== undefined) {
    entries.push(["thinkingTokens", lit(thinking.budgetTokens)]);
  }

  // Google-GenAI (and the xano-free wrapper) nest theirs in `thinkingConfig`.
  const thinkingConfig = config.thinkingConfig as
    | { includeThoughts?: unknown; thinkingBudget?: unknown }
    | undefined;
  if (thinkingConfig?.includeThoughts === true) entries.push(["includeThoughts", lit(true)]);
  if (thinkingConfig?.thinkingBudget !== undefined && thinkingConfig.thinkingBudget !== 0) {
    entries.push(["thinkingBudget", lit(thinkingConfig.thinkingBudget)]);
  }
  return entries;
}

/** An agent's `agent_settings` → the `llm` and `output` authoring blocks. */
function agentSettingsEntries(a: KindDecodeArgs): DefEntry[] {
  const settings = (a.stored.agent_settings ?? {}) as Record<string, unknown>;
  const type = String(settings.type ?? "");
  const configs = (settings.configs ?? {}) as Record<string, unknown>;
  const providerConfig = (configs[type] ?? {}) as Record<string, unknown>;

  const llm = compact([
    ["type", lit(type)] as DefEntry,
    settings.system_prompt ? (["systemPrompt", lit(settings.system_prompt)] as DefEntry) : null,
    settings.max_steps !== undefined && settings.max_steps !== 5
      ? (["maxSteps", lit(settings.max_steps)] as DefEntry)
      : null,
    settings.prompt_type === "messages"
      ? (["messages", lit(settings.prompt_messages)] as DefEntry)
      : settings.prompt
        ? (["prompt", lit(settings.prompt)] as DefEntry)
        : null,
    ...providerConfigEntries(providerConfig),
  ]);

  const entries: DefEntry[] = [["llm", obj(llm)]];

  const schema = settings.structuredOutputsSchema;
  if (Array.isArray(schema) && schema.length > 0) {
    a.ctx.use(CORE_MODULE, "input");
    entries.push([
      "output",
      obj(
        compact([
          settings.structuredOutputs === false ? (["enabled", lit(false)] as DefEntry) : null,
          ["schema", decodeFieldMap(a.ctx, a.refs, schema as never, "input", a.resolve)] as DefEntry,
        ]),
      ),
    ]);
  }
  return entries;
}

/** Kind decoders keyed by kind name. */
export const KIND_DECODERS_BY_NAME: ReadonlyMap<string, KindDecoder> = new Map(
  KIND_DECODERS.map((decoder) => [decoder.name, decoder]),
);

/** Decode one stored object into its def literal expression. */
export function decodeObject(decoder: KindDecoder, args: KindDecodeArgs): Expr {
  return obj(decoder.decode(args));
}

/** Re-exported for project assembly, which builds the barrel's register calls. */
export { id as symbolExpr };
