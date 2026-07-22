/**
 * MCP server (`mcp_server`) — a first-class root primitive: a collection of
 * tools exposed over the MCP protocol. Persists as `obj_type=toolset` with
 * `type:"mcp"` (verified against the Xano engine's stored mcp_server format),
 * so it shares the `toolset` payload
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
import { encodeToolsetBase, resolveToolsetCanonical } from "./toolset.js";
import type { ToolsetBaseDef, ToolsetBaseXdo } from "./toolset.js";

/** MCP server authoring def — the shared toolset envelope (no agent/LLM fields). */
export type McpServerDef = ToolsetBaseDef;

/** Options for {@link McpServerHandle.getPath}/`getUrl`. */
export interface McpPathOptions {
  /** Override the resolved `canonical` URL token (bypasses the def/lock lookup). */
  canonical?: string;
  /**
   * The URL-embedded auth token path segment. Defaults to `"mcp"` — the literal
   * placeholder the endpoint treats as "no URL token", meaning auth is passed via
   * the `Authorization: Bearer …` header instead. Pass a token to embed auth in
   * the path.
   */
  token?: string;
}

/**
 * An `mcpServer()` handle: the def plus URL accessors. It stays a plain data
 * descriptor with two added methods — dropped by `JSON.stringify` and ignored by
 * `encodeMcpServer`, so serialization and conformance are unaffected (mirrors
 * `QueryHandle`).
 */
export type McpServerHandle = McpServerDef & {
  /**
   * The MCP server's **Streamable HTTP** endpoint path —
   * `/x2/mcp/<canonical>/<token>/stream` — ready to prepend a host and point a
   * client at. The `canonical` is resolved from the def's `canonical` (or
   * `opts.canonical`, or the value frozen in `xano.lock`); it throws if none
   * resolves. `token` defaults to `"mcp"` (no URL auth).
   *
   * Streamable HTTP only — the SDK does not surface the legacy HTTP+SSE
   * transport (deprecated in the MCP spec).
   */
  getPath(opts?: McpPathOptions): string;
  /** The absolute endpoint URL — `baseUrl` (trailing slash trimmed) + {@link getPath}. */
  getUrl(baseUrl: string, opts?: McpPathOptions): string;
};

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

/**
 * Author an MCP server — a collection of tools exposed over the MCP protocol.
 * Returns an {@link McpServerHandle}: the def plus `getPath()`/`getUrl()`, so a
 * frontend or external client derives the endpoint URL from the def instead of
 * hardcoding it (the same derive-don't-hardcode contract `query.getPath()` gives
 * API endpoints).
 */
export function mcpServer(def: McpServerDef): McpServerHandle {
  const getPath = (opts?: McpPathOptions): string =>
    `/x2/mcp/${resolveToolsetCanonical(def, opts?.canonical)}/${opts?.token || "mcp"}/stream`;
  const getUrl = (baseUrl: string, opts?: McpPathOptions): string =>
    `${baseUrl.replace(/\/+$/, "")}${getPath(opts)}`;
  return { ...def, getPath, getUrl };
}
