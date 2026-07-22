/**
 * The two AI root primitives (both persist under payload key `toolset`).
 *
 * PARAM GATE: `mcpServer({...})` exposes tools over the MCP protocol (auth is
 * per-tool — Xano has no server-level auth gate); `agent({...})` is an LLM
 * orchestrator with a typed `llm` block that maps onto the engine's real
 * `agent_settings` wire shape.
 */
import { mcpServer, agent, query, s, inp, ref, input } from "@sidestep/core";
import { api } from "../_shared.js";
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
    // `{{ $args }}` is a Twig placeholder resolved at run time from the `args`
    // passed to s.ai.agent.run (below). When `args` is an object you address
    // fields as `{{ $args.field }}`; `{{ $env.NAME }}` reads env vars.
    prompt: "Answer this question: {{ $args }}",
    maxSteps: 5,
  },
  tools: [{ tool: searchTool }],
});

/**
 * Gate 3 — a worked endpoint that invokes the agent. `s.ai.agent.run` binds the
 * target by the agent's def handle (resolved to its `toolset` guid, remapped on
 * import like the call family), runs it, and returns the result. The endpoint's
 * `question` input is passed as `args`, landing in the agent's `$args` template
 * namespace — so `{{ $args }}` in the prompt above resolves to it at run time.
 */
export const askAssistant = query({
  name: "ex_ask_assistant",
  verb: "POST",
  apiGroup: api,
  input: { question: input.text({ required: true }) },
  stack: [s.ai.agent.run({ agent: assistant, args: inp("question"), as: "answer" })],
  response: ref("answer"),
});
