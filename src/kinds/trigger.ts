/**
 * Trigger kinds (U4). All 6 trigger types share ONE stored envelope
 * (`mvp_trigger`) discriminated by `obj_type` + a per-type `meta` block —
 * confirmed from `cloud-client: dbo/mvp/trigger.yaml`. The canonical `meta`
 * carries all four action groups (database / toolset / workspace /
 * workspace_realtime_channel); each trigger type populates its own group and
 * leaves the others at their skeleton defaults.
 *
 * Response-bearing types (realtime, mcp_server, agent) emit `result[]`;
 * config-only types (table, workspace, error) do not.
 *
 * **Implied inputs (U1-U4).** A trigger's inputs are fixed by type — Xano
 * generates them in `mvp:trigger_update_defaults` and they cannot be edited.
 * SideStep injects the exact per-type input array (`impliedInputs`) at encode
 * time and exposes those inputs to the stack through a typed handle `t`:
 * `stack: (t) => [...]`. There is no user-supplied `input` field — the implied
 * inputs are the only inputs. For a database trigger bound to a `table()`
 * handle, `t.new` / `t.old` are typed against the table's row, with nullability
 * keyed on the enabled actions (delete → `new` is null, insert → `old` is null).
 */
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import type { Value } from "../values/value.js";
import { inp, ref } from "../values/value.js";
import { setVar } from "../statements/set-var.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { defaultHistory, encodeTags } from "./common.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import type { InferRow } from "./table.js";
import { impliedInputs } from "./trigger-inputs.js";
import type { TriggerInputObjType } from "./trigger-inputs.js";
import { buildTriggerHandle } from "./trigger-handle.js";
import type {
  FieldAccessor,
  RealtimeInputs,
  ToolsetInputs,
  WorkspaceInputs,
  ErrorInputs,
} from "./trigger-handle.js";

/** The stored trigger `obj_type` (identical set to {@link TriggerInputObjType}). */
export type TriggerObjType = TriggerInputObjType;

export interface DatabaseActions {
  delete?: boolean;
  insert?: boolean;
  truncate?: boolean;
  update?: boolean;
}
export interface WorkspaceActions {
  branch_live?: boolean;
  branch_merge?: boolean;
  branch_new?: boolean;
}
export interface RealtimeActions {
  message?: boolean;
  join?: boolean;
}

// --- Database handle typing (U4) ---

/** The row type a database trigger references, or a `json` floor when no
 * `table()` handle is bound (a raw numeric `objId` carries no field brands). */
type TriggerRow<T> = [InferRow<T>] extends [never] ? Record<string, unknown> : InferRow<T>;

/** `new` is present when an insert or update action is enabled. */
type HasNew<A> = A extends { insert: true } ? true : A extends { update: true } ? true : false;
/** `old` is present when an update or delete action is enabled. */
type HasOld<A> = A extends { update: true } ? true : A extends { delete: true } ? true : false;

/**
 * The typed handle passed to a database trigger's `stack`. `action`/`datasource`
 * are always present; `new`/`old` are typed row accessors when their action is
 * enabled and `null` otherwise (delete → `new` null, insert → `old` null,
 * update → both, truncate → neither). A multi-action trigger offers both — the
 * runtime value can still be empty for the op that didn't fire, discriminated
 * via `t.action`.
 */
export type DatabaseInputs<Row, A> = {
  /** The database op (`"insert"` | `"update"` | `"delete"` | `"truncate"`). */
  action: Value;
  /** The data source label the change occurred on. */
  datasource: Value;
} & (HasNew<A> extends true ? { new: FieldAccessor<Row> } : { new: null }) &
  (HasOld<A> extends true ? { old: FieldAccessor<Row> } : { old: null });

/** The canonical four-group meta skeleton (per dbo/trigger.yaml). */
function baseMeta() {
  return {
    database: {
      datasource: [] as unknown[],
      search: { expression: [] as unknown[] },
      action: { delete: false, insert: false, truncate: false, update: false },
    },
    toolset: { action: { connection: false } },
    workspace: { action: { branch_live: false, branch_merge: false, branch_new: false } },
    workspace_realtime_channel: { action: { message: false, join: false } },
  };
}

/** Internal trigger def produced by the `trigger.*` factories. */
export interface TriggerDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  objType: TriggerObjType;
  /**
   * The bound object id. For a database trigger this is the target table — pass
   * a `table()` handle/name via the `table` factory arg instead and it resolves
   * to the table's portable guid (the engine remaps guid→local id on import,
   * exactly like a query's `app` binding). A raw numeric id is the escape hatch.
   */
  objId?: number | string;
  description?: string;
  active?: boolean;
  /** The resolved statement stack (the `stack` callback is invoked at factory time). */
  stack?: Statement[];
  /** The resolved response (response-bearing types only). */
  response?: ResponseDef;
  /** Whether this type emits a `result[]` (response-bearing). */
  hasResult: boolean;
  /** The per-type meta block (already populated for this type). */
  meta: Record<string, unknown>;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
}

export interface TriggerXdo {
  name: string;
  active: boolean;
  description: string;
  /** Numeric local id, or the bound object's guid (the portable form). */
  obj_id: number | string;
  obj_type: TriggerObjType;
  history: { inherit: boolean; enabled: boolean; limit: number };
  output: unknown[];
  meta: Record<string, unknown>;
  tag: unknown[];
  input: InputXdo[];
  run: StackItemXdo[];
  result?: ResultItemXdo[];
}

export function encodeTrigger(def: TriggerDef): TriggerXdo {
  if (!def.name) throw new Error("trigger: `name` is required.");
  const xdo: TriggerXdo = {
    name: def.name,
    active: def.active ?? true,
    description: def.description ?? "",
    obj_id: def.objId ?? 0,
    obj_type: def.objType,
    history: defaultHistory("trigger"),
    output: [],
    meta: def.meta,
    tag: encodeTags(def.tags),
    // Inputs are implied by type (fixed by Xano, not user-editable) — always
    // inject the canonical per-type array, never a user-supplied map.
    input: impliedInputs(def.objType),
    run: (def.stack ?? []).map(encodeStatement),
  };
  if (def.hasResult) {
    xdo.result = encodeResponse(def.response);
  } else {
    xdo.result = [];
  }
  return xdo;
}

/** Fields common to every trigger factory. Note: no `input` — trigger inputs
 * are implied by type and cannot be user-supplied. */
interface CommonArgs {
  name: string;
  /** Explicit Xano `guid` (defaults to a guid derived from `name`). */
  guid?: string;
  description?: string;
  active?: boolean;
  objId?: number;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
}

export const trigger = {
  /**
   * Database table trigger (obj_type=database). Config-only (no response). The
   * `stack` callback receives `t` with `t.new`/`t.old` (typed against the bound
   * `table` row) plus `t.action`/`t.datasource`.
   */
  table<const T extends ObjectRef | undefined = undefined, const A extends DatabaseActions = DatabaseActions>(
    args: CommonArgs & {
      table?: T;
      datasources?: string[];
      actions?: A;
      stack?: (t: DatabaseInputs<TriggerRow<T>, A>) => Statement[];
    },
  ): TriggerDef {
    const meta = baseMeta();
    meta.database.datasource = (args.datasources ?? []).map((tag) => ({ tag }));
    meta.database.action = {
      delete: args.actions?.delete ?? false,
      insert: args.actions?.insert ?? false,
      truncate: args.actions?.truncate ?? false,
      update: args.actions?.update ?? false,
    };
    // Bind to the target table by its portable guid (a `table()` handle or
    // name); a raw numeric `objId` stays the escape hatch.
    const objId = args.table !== undefined ? resolveRef("dbo", args.table) : args.objId;
    const t = buildTriggerHandle("database") as unknown as DatabaseInputs<TriggerRow<T>, A>;
    return {
      name: args.name,
      guid: args.guid,
      description: args.description,
      active: args.active,
      tags: args.tags,
      objId,
      objType: "database",
      hasResult: false,
      meta,
      stack: args.stack?.(t) ?? [],
    };
  },

  /** Realtime channel trigger (obj_type=workspace_realtime_channel). Response-bearing. */
  realtime(
    args: CommonArgs & {
      actions?: RealtimeActions;
      stack?: (t: RealtimeInputs) => Statement[];
      response?: (t: RealtimeInputs) => ResponseDef;
    },
  ): TriggerDef {
    const meta = baseMeta();
    meta.workspace_realtime_channel.action = {
      message: args.actions?.message ?? false,
      join: args.actions?.join ?? false,
    };
    const t = buildTriggerHandle("workspace_realtime_channel") as unknown as RealtimeInputs;
    return {
      name: args.name,
      guid: args.guid,
      description: args.description,
      active: args.active,
      tags: args.tags,
      objId: args.objId,
      objType: "workspace_realtime_channel",
      hasResult: true,
      meta,
      stack: args.stack?.(t) ?? [],
      // Xano default (updateResult): echo the `payload` input back.
      response: args.response ? args.response(t) : inp("payload"),
    };
  },

  /**
   * MCP server trigger (obj_type=toolset, connection action). Response-bearing.
   * Bind the target MCP server with `mcpServer` (a `mcpServer()` def handle or
   * its name) — it resolves to the toolset guid at export and survives a
   * `--reset` deploy. A raw numeric `objId` stays the escape hatch.
   */
  mcpServer(
    args: CommonArgs & {
      mcpServer?: ObjectRef;
      stack?: (t: ToolsetInputs) => Statement[];
      response?: (t: ToolsetInputs) => ResponseDef;
    },
  ): TriggerDef {
    return toolsetTrigger(args, args.mcpServer);
  },

  /**
   * Agent trigger (obj_type=toolset, connection action). Response-bearing.
   * Bind the target agent with `agent` (an `agent()` def handle or its name),
   * resolved to the toolset guid at export; `objId` is the raw escape hatch.
   */
  agent(
    args: CommonArgs & {
      agent?: ObjectRef;
      stack?: (t: ToolsetInputs) => Statement[];
      response?: (t: ToolsetInputs) => ResponseDef;
    },
  ): TriggerDef {
    return toolsetTrigger(args, args.agent);
  },

  /** Workspace lifecycle trigger (obj_type=workspace). Config-only. */
  workspace(
    args: CommonArgs & {
      actions?: WorkspaceActions;
      stack?: (t: WorkspaceInputs) => Statement[];
    },
  ): TriggerDef {
    const meta = baseMeta();
    meta.workspace.action = {
      branch_live: args.actions?.branch_live ?? false,
      branch_merge: args.actions?.branch_merge ?? false,
      branch_new: args.actions?.branch_new ?? false,
    };
    const t = buildTriggerHandle("workspace") as unknown as WorkspaceInputs;
    return {
      name: args.name,
      guid: args.guid,
      description: args.description,
      active: args.active,
      tags: args.tags,
      objId: args.objId,
      objType: "workspace",
      hasResult: false,
      meta,
      stack: args.stack?.(t) ?? [],
    };
  },

  /** Error trigger (obj_type=error, empty meta). Config-only. */
  error(
    args: CommonArgs & {
      stack?: (t: ErrorInputs) => Statement[];
    },
  ): TriggerDef {
    const t = buildTriggerHandle("error") as unknown as ErrorInputs;
    return {
      name: args.name,
      guid: args.guid,
      description: args.description,
      active: args.active,
      tags: args.tags,
      objId: args.objId,
      objType: "error",
      hasResult: false,
      meta: {},
      stack: args.stack?.(t) ?? [],
    };
  },
};

/**
 * Shared MCP-server / agent trigger construction (both are `obj_type=toolset`).
 * `target` is the bound toolset handle (from `mcpServer`/`agent`); it resolves
 * against the shared `toolset` migrate type — matching the object's own
 * `md5("toolset:"+name)` guid — so binding is guid-stable across a `--reset`.
 * Mirrors the `table` trigger's handle-binding precedence (handle wins; a raw
 * numeric `objId` is the fallback escape hatch).
 */
function toolsetTrigger(
  args: CommonArgs & {
    stack?: (t: ToolsetInputs) => Statement[];
    response?: (t: ToolsetInputs) => ResponseDef;
  },
  target?: ObjectRef,
): TriggerDef {
  const meta = baseMeta();
  meta.toolset.action.connection = true;
  const t = buildTriggerHandle("toolset") as unknown as ToolsetInputs;
  return {
    name: args.name,
    guid: args.guid,
    description: args.description,
    active: args.active,
    tags: args.tags,
    objId: target !== undefined ? resolveRef("toolset", target) : args.objId,
    objType: "toolset",
    hasResult: true,
    meta,
    // Xano default (updateRun): copy the toolset/tools inputs into stack vars.
    stack: args.stack ? args.stack(t) : [setVar("toolset", inp("toolset")), setVar("tools", inp("tools"))],
    // Xano default (updateResult): return the toolset/tools vars.
    response: args.response ? args.response(t) : { toolset: ref("toolset"), tools: ref("tools") },
  };
}

export const triggerKind: ObjectKind<TriggerDef, TriggerXdo> = {
  name: "trigger",
  payloadKey: "trigger",
  encode: encodeTrigger,
};

registerKind(triggerKind);
