/**
 * Workspace config kind (U8) → payload key `workspace` (singleton object, not
 * an array). Emits the author-provided settings subset; the engine fills the
 * remaining server-managed fields on import (KTD-1). Authoring shape validated
 * against the Xano engine's persisted workspace shape.
 */
import type { StackItemXdo } from "../types/xdo.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeMiddlewareList } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { buildWorkspaceHistory } from "./history.js";
import type { WorkspaceHistoryDef, WorkspaceHistoryXdo } from "./history.js";

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

/**
 * One non-live datasource defined on the workspace. `label` is the datasource
 * name queries target; `color` is the editor's tint for it.
 */
export interface WorkspaceDatasourceDef {
  label: string;
  color?: string;
}

/** Editor presentation for the `live` datasource, which has no `datasources[]` entry. */
export interface WorkspaceDatasourceLiveDef {
  color?: string;
  show_banner?: boolean;
}

/** Workspace-wide defaults applied when creating new objects. */
export interface WorkspaceDefaultsDef {
  /** Primary-key type new tables get when they don't declare one. */
  db_primary_key?: "int" | "uuid";
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
  /**
   * The workspace's LEGACY realtime block, carried verbatim.
   *
   * Not the realtime primitives this SDK authors — those are `realtimeServer` /
   * `realtimeChannel` / `realtimeMessage`, each its own object with its own
   * canonical. This is the older workspace-level block that predates them, and
   * SideStep models none of its members: whatever the engine stored is round-
   * tripped as-is, so a pulled workspace keeps it without this SDK taking a
   * position on a shape it does not author.
   *
   * Omit it. It exists so the round trip is honest, not to be authored.
   */
  realtime?: Record<string, unknown>;
  /**
   * The workspace's public-documentation block, carried verbatim — the token and
   * whitelist gating the hosted docs. Server-shaped; omit unless round-tripping
   * a pulled workspace.
   */
  documentation?: Record<string, unknown>;
  /** Whether the workspace publishes a Swagger/OpenAPI spec. */
  swagger?: boolean;
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
  /**
   * Workspace-level default request history (the terminal fallback tier). A
   * scalar per object type; every type an object of that kind inherits when it
   * (and, for queries/tools, its container) doesn't customize. Unlike the
   * object/container tiers there is **no `inherit` flag** — the workspace is
   * always terminal.
   *
   * WHOLESALE, not partial: once set, the full 14-key `{objType}_enabled`/
   * `{objType}_limit` map is emitted and any type you don't list falls back to
   * its engine default (`enabled` per the kind rule, `limit:100`) — deploying
   * `{ query: 100 }` overwrites any UI-configured `function_*`/`task_*`/… values.
   * Declare every workspace-level default you want to keep. Branch-tier history
   * is not modeled; the engine falls through absent branch history to this tier.
   */
  history?: WorkspaceHistoryDef;
  /**
   * Workspace **environment variables** — the secrets/config a tenant reads at
   * request time with `env("NAME")` (→ `$env.NAME`). Authored as an ergonomic
   * name→value map; SideStep encodes it to the engine's persisted `env[]` array
   * of `{ name, value, market_item }`. Order is preserved.
   *
   * VALUES ARE SECRETS. Prefer sourcing them from the deploy environment rather
   * than committing literals — `env: { STRIPE_KEY: process.env.STRIPE_KEY! }` —
   * and don't commit a compiled bundle that contains real values.
   *
   * Deploying replaces the tenant's env vars with this map (the workspace
   * object is restored wholesale on import); omit the field to leave existing
   * env untouched. This is the SETTER — the {@link env} value helper is the
   * READER. Distinct from the built-in request-context vars (`sys.*`).
   */
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
  /**
   * Allow tables to carry custom SQL names distinct from their workspace names.
   * Emitted only when set — omit to leave the tenant's current setting alone.
   */
  use_custom_names?: boolean;
  /**
   * Workspace-wide defaults for newly created objects. Emitted only when set,
   * so omitting it leaves the tenant's configured defaults untouched.
   */
  defaults?: WorkspaceDefaultsDef;
  /**
   * The workspace's non-live datasources. WHOLESALE, not partial: once set, the
   * full list is emitted and any datasource you don't list is dropped from the
   * tenant. Omit the field to leave the existing datasources alone.
   */
  datasources?: WorkspaceDatasourceDef[];
  /** Editor presentation for the `live` datasource. Emitted only when set. */
  datasource_live?: WorkspaceDatasourceLiveDef;
}

/** One persisted workspace env var (engine `env[]` element). */
export interface WorkspaceEnvXdo {
  name: string;
  value: string;
  /** Marketplace-provenance links; always empty for author-declared vars. */
  market_item: never[];
}

/**
 * The engine's empty LEGACY realtime block — what a workspace that never used the
 * older workspace-level realtime carries. Emitted when the author omits the
 * field, so the round trip matches a real export instead of inventing a shape.
 */
const LEGACY_REALTIME: Record<string, unknown> = {
  hash: "",
  mode: "",
  enabled: false,
  channels: [],
};

/** The engine's default documentation block — docs open, no token, no whitelist. */
const DEFAULT_DOCUMENTATION: Record<string, unknown> = {
  token: "",
  whitelist: {},
  require_token: false,
};

export interface WorkspaceConfigXdo {
  name: string;
  description: string;
  canonical: string;
  use_xdo: boolean;
  preferences: WorkspacePreferences;
  realtime: Record<string, unknown>;
  documentation: Record<string, unknown>;
  swagger: boolean;
  /** Present only when the author sets `middleware` (author-provided subset). */
  middleware?: WorkspaceMiddlewareXdo;
  /** Present only when the author sets `history` (author-provided subset). */
  history?: WorkspaceHistoryXdo;
  env: WorkspaceEnvXdo[];
  settings: Record<string, unknown>;
  /**
   * The four blocks below are `?=`-optional in the engine's workspace schema and
   * are emitted **by presence only** — written when the author sets them, absent
   * when they don't. Comparing against a default instead would make the lean
   * shape Xano's own editor persists and the explicit shape an author asks for
   * collapse to the same bytes, and only one of them would round-trip.
   */
  use_custom_names?: boolean;
  defaults?: WorkspaceDefaultsDef;
  datasources?: WorkspaceDatasourceDef[];
  datasource_live?: WorkspaceDatasourceLiveDef;
}

/**
 * Encode the author's name→value env map into the engine's persisted `env[]`
 * array, preserving insertion order. Each var carries an empty `market_item`
 * (author-declared vars have no marketplace provenance).
 */
export function encodeWorkspaceEnv(env: Record<string, string>): WorkspaceEnvXdo[] {
  return Object.entries(env).map(([name, value]) => ({ name, value, market_item: [] }));
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
  // Present-but-empty is accepted, absent is not. A real instance holds a
  // workspace whose stored `name` is `""` — the engine allows it — and refusing
  // that spelling made a faithful pull of it impossible to export at all, which
  // is the SDK inventing a stricter rule than the engine's. A MISSING key is
  // still a mistake worth catching, since the type says the field is there.
  if (def.name === undefined || def.name === null) {
    throw new Error("workspace: `name` is required.");
  }
  return {
    name: def.name,
    description: def.description ?? "",
    canonical: def.canonical ?? "",
    use_xdo: def.use_xdo ?? false,
    preferences: def.preferences ?? {},
    realtime: def.realtime ?? { ...LEGACY_REALTIME },
    documentation: def.documentation ?? { ...DEFAULT_DOCUMENTATION },
    swagger: def.swagger ?? false,
    ...(def.middleware !== undefined
      ? { middleware: encodeWorkspaceMiddleware(def.middleware) }
      : {}),
    ...(def.history !== undefined ? { history: buildWorkspaceHistory(def.history) } : {}),
    env: def.env ? encodeWorkspaceEnv(def.env) : [],
    settings: def.settings ?? {},
    // Presence-preserving: each key is written only when the author set it, and
    // each nested optional likewise, so a pulled workspace re-exports to its own
    // bytes whether or not the engine happened to store the `?=` default.
    ...(def.use_custom_names !== undefined ? { use_custom_names: def.use_custom_names } : {}),
    ...(def.defaults !== undefined ? { defaults: { ...def.defaults } } : {}),
    ...(def.datasources !== undefined
      ? { datasources: def.datasources.map((d) => ({ ...d })) }
      : {}),
    ...(def.datasource_live !== undefined ? { datasource_live: { ...def.datasource_live } } : {}),
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
