/**
 * MCP server (`mcp_server`) — a first-class root primitive: a collection of
 * tools exposed over the MCP protocol. Persists as `obj_type=toolset` with
 * `type:"mcp"` (verified against `cloud-client` `transform/McpServer.php` +
 * stored `schema:mcp_server` fixtures), so it shares the `toolset` payload
 * section and the `md5("toolset:"+name)` guid with agents (see the note in
 * `xano.ts`/`refs/guid.ts` about the shared identity namespace).
 *
 * Authoring surface = the shared {@link encodeToolsetBase} envelope
 * (name/description/instructions/docs/enabled/canonical/spec/tags/tools). There
 * is deliberately **no** server-level `authentication` field: Xano's MCP server
 * has none — auth is per-tool (`tool[].auth`, see {@link ToolsetToolRef}). There
 * is also no toolset-level `middleware`: the engine runs middleware per-tool,
 * not per-toolset (module header in `toolset.ts`).
 */
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeToolsetBase } from "./toolset.js";
import type { ToolsetBaseDef, ToolsetBaseXdo } from "./toolset.js";

export interface McpServerDef extends ToolsetBaseDef {}

export interface McpServerXdo extends ToolsetBaseXdo {
  type: "mcp";
}

export function encodeMcpServer(def: McpServerDef): McpServerXdo {
  if (!def.name) throw new Error("mcp server: `name` is required.");
  return { ...encodeToolsetBase(def), type: "mcp" };
}

export const mcpServerKind: ObjectKind<McpServerDef, McpServerXdo> = {
  name: "mcp_server",
  payloadKey: "toolset",
  encode: encodeMcpServer,
};
registerKind(mcpServerKind);

/** Author an MCP server — a collection of tools exposed over the MCP protocol. */
export function mcpServer(def: McpServerDef): McpServerDef {
  return def;
}
