/**
 * Toolsets (payload key `toolset`).
 *
 * PARAM GATE: `toolset.mcp({...})` exposes tools over the MCP protocol; an
 * `agent({...})` is an LLM orchestrator with `agentSettings`.
 */
import { toolset, agent } from "@sidestep/core";
import { searchTool } from "./tool.js";

/** Gate 1 — an MCP server exposing tools. */
export const mcpServer = toolset.mcp({
  name: "ex_kind_mcp_server",
  canonical: "assistant-mcp",
  tools: [{ tool: searchTool, enabled: true }],
});

/** Gate 2 — an AI agent (LLM orchestrator). Its `name` is referenced by `s.ai.agent.run`. */
export const assistant = agent({
  name: "ex_assistant",
  agentSettings: { type: "anthropic", model: "claude-sonnet-5", system_prompt: "You are a helpful assistant." },
  tools: [{ tool: searchTool }],
});
