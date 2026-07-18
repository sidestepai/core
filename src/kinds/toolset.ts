/**
 * Toolset family (U5): `tool`, `toolset` (type "mcp" | "agent"), and `agent`
 * (a toolset with type "agent" + agent_settings). Clarifies the AI-vs-MCP
 * distinction:
 *  - **MCP toolset** (`type:"mcp"`): a collection of independent tools exposed
 *    via the MCP protocol; carries `tool[]` references + an OpenAPI `spec`.
 *  - **AI/agent toolset** (`type:"agent"`): an LLM orchestrator; carries
 *    `agent_settings` (model/provider/system_prompt/…) plus its `tool[]`.
 *
 * A `tool` is its own kind (`mvp_tool`, payload key `tool`) — function-like
 * (input/run/result) plus `instructions`/`middleware`. Tools reproduce cleanly
 * from the shared input/statement/response encoders.
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
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";

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
    middleware: emptyMiddleware(),
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

// ---------- toolset (mcp | agent) ----------

export type ToolsetType = "mcp" | "agent";

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
  auth?: unknown;
}

/** Encoded tool reference: `id` carries the resolved guid (or the raw numeric id). */
interface ToolsetToolXdo {
  id: number | string;
  enabled: boolean;
  auth: unknown;
}

/** Agent (LLM) settings — present only when type === "agent". */
export interface AgentSettings {
  type?: string; // provider: anthropic | openai | ...
  model?: string;
  system_prompt?: string;
  prompt?: string;
  prompt_messages?: string;
  prompt_type?: string;
  max_steps?: number;
  configs?: Record<string, unknown>;
  structuredOutputs?: boolean;
  structuredOutputsSchema?: unknown[];
}

export interface ToolsetDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  type: ToolsetType;
  description?: string;
  instructions?: string;
  docs?: string;
  enabled?: boolean;
  canonical?: string;
  spec?: string;
  tags?: string[];
  tools?: ToolsetToolRef[];
  agentSettings?: AgentSettings;
}

export interface ToolsetXdo {
  name: string;
  description: string;
  instructions: string;
  docs: string;
  enabled: boolean;
  canonical: string;
  spec: string;
  type: ToolsetType;
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  tool: ToolsetToolXdo[];
  agent_settings?: AgentSettings;
}

export function encodeToolset(def: ToolsetDef): ToolsetXdo {
  if (!def.name) throw new Error("toolset: `name` is required.");
  const xdo: ToolsetXdo = {
    name: def.name,
    description: def.description ?? "",
    instructions: def.instructions ?? "",
    docs: def.docs ?? "",
    enabled: def.enabled ?? true,
    canonical: def.canonical ?? "",
    spec: def.spec ?? "",
    type: def.type,
    middleware: emptyMiddleware(),
    tag: encodeTags(def.tags),
    tool: (def.tools ?? []).map((t) => {
      if (t.tool !== undefined && t.id !== undefined) {
        throw new Error("toolset tool ref: set either `tool` (handle/name) or `id` (raw), not both.");
      }
      const id = t.tool !== undefined ? resolveRef("tool", t.tool) : (t.id ?? 0);
      return { id, enabled: t.enabled ?? true, auth: t.auth ?? null };
    }),
  };
  if (def.type === "agent") {
    xdo.agent_settings = def.agentSettings ?? {};
  }
  return xdo;
}

export const toolsetKind: ObjectKind<ToolsetDef, ToolsetXdo> = {
  name: "toolset",
  payloadKey: "toolset",
  encode: encodeToolset,
};
registerKind(toolsetKind);

/** Factory sugar for the toolset family. */
export const toolset = {
  /** An MCP toolset: a collection of tools exposed via MCP. */
  mcp(args: Omit<ToolsetDef, "type" | "agentSettings">): ToolsetDef {
    return { ...args, type: "mcp" };
  },
  /** An agent (AI) toolset: an LLM orchestrator with agent_settings. */
  agent(args: Omit<ToolsetDef, "type">): ToolsetDef {
    return { ...args, type: "agent" };
  },
};

/** Convenience alias: author an agent toolset directly. */
export function agent(args: Omit<ToolsetDef, "type">): ToolsetDef {
  return toolset.agent(args);
}
