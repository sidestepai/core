/**
 * Workspace config kind (U8) → payload key `workspace` (singleton object, not
 * an array). Emits the author-provided settings subset; the engine fills the
 * remaining server-managed fields on import (KTD-1). Authoring shape per
 * `cloud-client: script/kind/schema/core/workspace.yaml`.
 */
import type { StackItemXdo } from "../types/xdo.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeMiddlewareList } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";

export interface WorkspacePreferences {
  internal_docs?: boolean;
  sql_columns?: boolean;
  sql_names?: boolean;
  track_performance?: boolean;
}

/**
 * Workspace-tier middleware — the **terminal fallback** of the
 * Query → API Group → Workspace chain. Keyed by host type; each host's
 * `pre`/`post` is the default chain a host of that type inherits when it (and,
 * for queries, its API group) don't customize. Unlike the object/group tiers
 * there are **no `_customize` flags** here — workspace is always terminal, so
 * an empty list simply means "no workspace-level middleware for that host".
 */
export interface WorkspaceMiddlewareDef {
  query?: MiddlewareAttach;
  function?: MiddlewareAttach;
  task?: MiddlewareAttach;
  tool?: MiddlewareAttach;
}

/** The stored 8-key workspace middleware map (`{objType}_{phase}`). */
export interface WorkspaceMiddlewareXdo {
  function_pre: StackItemXdo[];
  function_post: StackItemXdo[];
  query_pre: StackItemXdo[];
  query_post: StackItemXdo[];
  task_pre: StackItemXdo[];
  task_post: StackItemXdo[];
  tool_pre: StackItemXdo[];
  tool_post: StackItemXdo[];
}

export interface WorkspaceConfigDef {
  name: string;
  description?: string;
  canonical?: string;
  /**
   * Default storage mode for tables in this workspace: `true` stores fields as
   * JSON under each table's `xdo` column, `false` (the default) gives them real
   * Postgres columns. The source of truth a table's own `use_xdo` mirrors — keep
   * them in sync (see {@link TableDef.useXdo}).
   */
  use_xdo?: boolean;
  preferences?: WorkspacePreferences;
  realtime?: { canonical?: string };
  /**
   * Workspace-level default middleware chains (the terminal fallback tier).
   * Emitted only when provided — a workspace config without this field leaves
   * the engine's existing workspace middleware untouched on import (consistent
   * with this kind's author-provided-subset contract).
   *
   * WHOLESALE, not partial: once set, the full 8-key `{host}_{phase}` map is
   * emitted and any host/phase you don't list is emitted empty. The workspace
   * tier has no per-key `_customize` flag, so an empty list means "no middleware"
   * — deploying `{ query: { pre: [x] } }` **clears** any UI-configured
   * `function_*`/`task_*`/`tool_*`/`query_post` middleware. Declare every
   * workspace-level chain you want to keep. Branch-tier middleware is not
   * modeled; the engine falls through absent branch middleware to this tier.
   */
  middleware?: WorkspaceMiddlewareDef;
  env?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface WorkspaceConfigXdo {
  name: string;
  description: string;
  canonical: string;
  use_xdo: boolean;
  preferences: WorkspacePreferences;
  realtime: { canonical: string };
  /** Present only when the author sets `middleware` (author-provided subset). */
  middleware?: WorkspaceMiddlewareXdo;
  env: Record<string, unknown>;
  settings: Record<string, unknown>;
}

/** Encode the author's per-host middleware into the flat 8-key stored map. */
function encodeWorkspaceMiddleware(m: WorkspaceMiddlewareDef): WorkspaceMiddlewareXdo {
  return {
    function_pre: encodeMiddlewareList(m.function?.pre),
    function_post: encodeMiddlewareList(m.function?.post),
    query_pre: encodeMiddlewareList(m.query?.pre),
    query_post: encodeMiddlewareList(m.query?.post),
    task_pre: encodeMiddlewareList(m.task?.pre),
    task_post: encodeMiddlewareList(m.task?.post),
    tool_pre: encodeMiddlewareList(m.tool?.pre),
    tool_post: encodeMiddlewareList(m.tool?.post),
  };
}

export function encodeWorkspaceConfig(def: WorkspaceConfigDef): WorkspaceConfigXdo {
  if (!def.name) throw new Error("workspace: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    canonical: def.canonical ?? "",
    use_xdo: def.use_xdo ?? false,
    preferences: def.preferences ?? {},
    realtime: { canonical: def.realtime?.canonical ?? "" },
    ...(def.middleware !== undefined
      ? { middleware: encodeWorkspaceMiddleware(def.middleware) }
      : {}),
    env: def.env ?? {},
    settings: def.settings ?? {},
  };
}

export const workspaceKind: ObjectKind<WorkspaceConfigDef, WorkspaceConfigXdo> = {
  name: "workspace",
  payloadKey: "workspace",
  encode: encodeWorkspaceConfig,
};
registerKind(workspaceKind);

export function workspaceConfig(def: WorkspaceConfigDef): WorkspaceConfigDef {
  return def;
}
