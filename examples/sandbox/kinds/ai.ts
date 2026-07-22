/**
 * The two AI root primitives (both persist under payload key `toolset`).
 *
 * PARAM GATE: `mcpServer({...})` exposes tools over the MCP protocol (auth is
 * per-tool — Xano has no server-level auth gate); `agent({...})` is an LLM
 * orchestrator with a typed `llm` block that maps onto the engine's real
 * `agent_settings` wire shape.
 */
import { mcpServer, agent } from "@sidestep/core";
import { searchTool } from "./tool.js";

/** Gate 1 — an MCP server exposing tools. */
export const exampleMcpServer = mcpServer({
  name: "ex_kind_mcp_server",
  canonical: "assistant-mcp",
  instructions: "Expose the search tool over MCP.",
  tools: [{ tool: searchTool, enabled: true }],
});

/**
 * Gate 2 — a zero-config `xano-free` agent (no API key needed). Its `name` is
 * referenced from an endpoint via `s.ai.agent.run` (see kinds/query.ts).
 */
export const assistant = agent({
  name: "ex_assistant",
  canonical: "assistant-agent",
  llm: {
    type: "xano-free",
    systemPrompt: "You are a helpful assistant.",
    prompt: "Answer the user's question.",
    maxSteps: 5,
  },
  tools: [{ tool: searchTool }],
});
