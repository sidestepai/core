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
 */
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { defaultHistory, encodeTags } from "./common.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";

export type TriggerObjType =
  | "database"
  | "workspace_realtime_channel"
  | "toolset"
  | "workspace"
  | "error";

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
  input?: Record<string, InputDescriptor>;
  stack?: Statement[];
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
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    run: (def.stack ?? []).map(encodeStatement),
  };
  if (def.hasResult) {
    xdo.result = encodeResponse(def.response);
  } else {
    xdo.result = [];
  }
  return xdo;
}

interface CommonArgs {
  name: string;
  /** Explicit Xano `guid` (defaults to a guid derived from `name`). */
  guid?: string;
  description?: string;
  active?: boolean;
  objId?: number;
  input?: Record<string, InputDescriptor>;
  stack?: Statement[];
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
}

export const trigger = {
  /** Database table trigger (obj_type=database). Config-only (no response). */
  table(
    args: CommonArgs & { table?: ObjectRef; datasources?: string[]; actions?: DatabaseActions },
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
    return { ...args, objId, objType: "database", hasResult: false, meta };
  },

  /** Realtime channel trigger (obj_type=workspace_realtime_channel). Response-bearing. */
  realtime(args: CommonArgs & { actions?: RealtimeActions; response?: ResponseDef }): TriggerDef {
    const meta = baseMeta();
    meta.workspace_realtime_channel.action = {
      message: args.actions?.message ?? false,
      join: args.actions?.join ?? false,
    };
    return { ...args, objType: "workspace_realtime_channel", hasResult: true, meta };
  },

  /** MCP server trigger (obj_type=toolset, connection action). Response-bearing. */
  mcpServer(args: CommonArgs & { response?: ResponseDef }): TriggerDef {
    const meta = baseMeta();
    meta.toolset.action.connection = true;
    return { ...args, objType: "toolset", hasResult: true, meta };
  },

  /** Agent trigger (obj_type=toolset, connection action). Response-bearing. */
  agent(args: CommonArgs & { response?: ResponseDef }): TriggerDef {
    const meta = baseMeta();
    meta.toolset.action.connection = true;
    return { ...args, objType: "toolset", hasResult: true, meta };
  },

  /** Workspace lifecycle trigger (obj_type=workspace). Config-only. */
  workspace(args: CommonArgs & { actions?: WorkspaceActions }): TriggerDef {
    const meta = baseMeta();
    meta.workspace.action = {
      branch_live: args.actions?.branch_live ?? false,
      branch_merge: args.actions?.branch_merge ?? false,
      branch_new: args.actions?.branch_new ?? false,
    };
    return { ...args, objType: "workspace", hasResult: false, meta };
  },

  /** Error trigger (obj_type=error, empty meta). Config-only. */
  error(args: CommonArgs): TriggerDef {
    return { ...args, objType: "error", hasResult: false, meta: {} };
  },
};

export const triggerKind: ObjectKind<TriggerDef, TriggerXdo> = {
  name: "trigger",
  payloadKey: "trigger",
  encode: encodeTrigger,
};

registerKind(triggerKind);
