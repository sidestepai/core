/**
 * Toolset family. A `tool` is its own kind (`mvp_tool`, payload key `tool`) —
 * function-like (input/run/result) plus `instructions`/`middleware`. The two AI
 * primitives that persist as `obj_type=toolset` — **MCP servers**
 * (`mcp-server.ts`, `type:"mcp"`) and **agents** (`agent.ts`, `type:"agent"`) —
 * are their own root kinds; both build on the shared {@link encodeToolsetBase}
 * envelope exported here (name/description/instructions/docs/enabled/canonical/
 * spec/tags/tool-refs). Verified against the Xano engine's stored mcp_server and
 * agent formats.
 *
 * Notes from that verification (see the PR for #85/#87):
 *  - Xano's MCP server has **no** server-level `authentication` field — auth is
 *    per-tool (`tool[].auth`, a stored `json`, engine default `false`).
 *  - Toolset-level middleware is **not** an engine feature: neither transform
 *    reads a `middleware` block and `getMiddlewareForObject` hosts only
 *    query/function/task/**tool**. The stored empty `middleware` skeleton is an
 *    inert DBO default, emitted here for shape parity but never authorable.
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
import { emptyMiddleware, encodeTags, defaultHistory } from "./common.js";
import type { MiddlewareBlock } from "./common.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import { resolveAuthRef } from "../refs/auth.js";
import type { AuthRef } from "../refs/auth.js";

// ---------- tool ----------

export interface ToolDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  instructions?: string;
  docs?: string;
  enabled?: boolean;
  toolsetId?: number;
  tags?: string[];
  history?: { inherit?: boolean; enabled?: boolean; limit?: number };
  input?: Record<string, InputDescriptor>;
  stack?: Statement[];
  response?: ResponseDef;
  /**
   * Pre/post middleware attachment (per-tool — the `tool_pre`/`tool_post`
   * workspace keys). Providing a phase sets its `_customize` flag; an
   * un-customized phase inherits from the workspace. `pre: middleware.clear()`
   * overrides with nothing.
   */
  middleware?: MiddlewareAttach;
}

export interface ToolXdo {
  name: string;
  description: string;
  instructions: string;
  docs: string;
  enabled: boolean;
  output: unknown[];
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  history: { inherit: boolean; enabled: boolean; limit: number };
  toolset: { id: number };
  input: InputXdo[];
  result: ResultItemXdo[];
  run: StackItemXdo[];
  test: unknown[];
}

export function encodeTool(def: ToolDef): ToolXdo {
  if (!def.name) throw new Error("tool: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    instructions: def.instructions ?? "",
    docs: def.docs ?? "",
    enabled: def.enabled ?? true,
    output: [],
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: defaultHistory("toolset", def.history),
    toolset: { id: def.toolsetId ?? 0 },
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    result: encodeResponse(def.response),
    run: (def.stack ?? []).map(encodeStatement),
    test: [],
  };
}

export const toolKind: ObjectKind<ToolDef, ToolXdo> = {
  name: "tool",
  payloadKey: "tool",
  encode: encodeTool,
};
registerKind(toolKind);

/** Authoring factory for a `tool` — a function-like operation a toolset references. */
export function tool(def: ToolDef): ToolDef {
  return def;
}

// ---------- shared toolset internals (used by mcp-server.ts + agent.ts) ----------

/**
 * A tool reference within a toolset.
 *
 * Prefer `tool` — a `tool()` def handle (or its name). It resolves to the
 * tool's guid at export, the same cross-object-reference mechanism the call
 * family uses (`s.tool.call`), so the toolset and the tool's payload `guid`
 * agree and a sync import remaps both together. `id` (a raw numeric engine id)
 * remains as an escape hatch for adopting an existing engine-side toolset.
 */
export interface ToolsetToolRef {
  /** The tool to expose: a `tool()` def handle or its name (resolved to the tool's guid at export). */
  tool?: ObjectRef;
  /** Raw numeric engine id — escape hatch; prefer `tool`. */
  id?: number;
  enabled?: boolean;
  /**
   * Per-tool auth — Xano's **only** MCP auth surface (there is no server-level
   * gate). Works exactly like a query's `auth`: name an auth **table** (a
   * `table({ auth: true })` def or its name) and it resolves to that table's
   * guid at export (the engine's `dbo` id↔guid remap); a raw numeric `dbo.id`
   * is the escape hatch, and `false`/omitted means no auth (the engine default).
   */
  auth?: AuthRef;
}

/** Encoded tool reference: `id` carries the resolved guid; `auth` the resolved auth-table guid / dbo.id / `false`. */
interface ToolsetToolXdo {
  id: number | string;
  enabled: boolean;
  auth: false | number | string;
}

/** Resolve a list of {@link ToolsetToolRef}s to their stored `tool[]` entries. */
export function encodeToolRefs(tools?: ToolsetToolRef[]): ToolsetToolXdo[] {
  return (tools ?? []).map((t) => {
    if (t.tool !== undefined && t.id !== undefined) {
      throw new Error("toolset tool ref: set either `tool` (handle/name) or `id` (raw), not both.");
    }
    const id = t.tool !== undefined ? resolveRef("tool", t.tool) : (t.id ?? 0);
    const label = typeof t.tool === "string" ? t.tool : (t.tool?.name ?? String(t.id ?? "?"));
    return { id, enabled: t.enabled ?? true, auth: resolveAuthRef("toolset tool", label, t.auth) };
  });
}

/**
 * Fields shared by every toolset-family primitive (MCP server + agent). The
 * type-specific encoders add `type` and, for agents, `agent_settings`.
 * `instructions` is a stored column for both but only authorable on MCP servers
 * (Xano's `Agent` transform has no `instructions` field), so `AgentDef` simply
 * omits it and it stays `""`.
 */
export interface ToolsetBaseDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  instructions?: string;
  docs?: string;
  enabled?: boolean;
  canonical?: string;
  spec?: string;
  tags?: string[];
  tools?: ToolsetToolRef[];
}

/** The shared toolset envelope — everything except the type discriminator and agent-only `agent_settings`. */
export interface ToolsetBaseXdo {
  name: string;
  description: string;
  instructions: string;
  docs: string;
  enabled: boolean;
  canonical: string;
  spec: string;
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  tool: ToolsetToolXdo[];
}

/**
 * Build the shared toolset envelope. Assumes `def.name` is set — each kind's
 * encoder validates `name` first so it can throw a kind-specific message.
 * `middleware` is the inert empty skeleton (toolset-level middleware is not an
 * engine feature — see the module header); `spec` is a stored column the
 * XanoScript transform ignores, kept for DBO shape parity.
 */
export function encodeToolsetBase(def: ToolsetBaseDef): ToolsetBaseXdo {
  return {
    name: def.name,
    description: def.description ?? "",
    instructions: def.instructions ?? "",
    docs: def.docs ?? "",
    enabled: def.enabled ?? true,
    canonical: def.canonical ?? "",
    spec: def.spec ?? "",
    middleware: emptyMiddleware(),
    tag: encodeTags(def.tags),
    tool: encodeToolRefs(def.tools),
  };
}
