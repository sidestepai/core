/**
 * Workspace config kind (U8) → payload key `workspace` (singleton object, not
 * an array). Emits the author-provided settings subset; the engine fills the
 * remaining server-managed fields on import (KTD-1). Authoring shape per
 * `cloud-client: script/kind/schema/core/workspace.yaml`.
 */
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";

export interface WorkspacePreferences {
  internal_docs?: boolean;
  sql_columns?: boolean;
  sql_names?: boolean;
  track_performance?: boolean;
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
  env: Record<string, unknown>;
  settings: Record<string, unknown>;
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
