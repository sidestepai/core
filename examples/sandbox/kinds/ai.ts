/**
 * The two AI root primitives (both persist under payload key `toolset`).
 *
 * PARAM GATE: `mcpServer({...})` exposes tools over the MCP protocol (auth is
 * per-tool — Xano has no server-level auth gate); `agent({...})` is an LLM
 * orchestrator with a typed `llm` block that maps onto the engine's real
 * `agent_settings` wire shape.
 */
import { mcpServer, agent, query, s, inp, obj, ref, input } from "@sidestep/core";
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
    // `{{ $args.* }}` is a Twig placeholder resolved at run time from the `args`
    // object passed to s.ai.agent.run (below). `{{ $env.NAME }}` reads env vars.
    prompt: "Answer this question: {{ $args.question }}",
    maxSteps: 5,
  },
  tools: [{ tool: searchTool }],
});

/**
 * Gate 3 — a worked endpoint that invokes the agent. `s.ai.agent.run` binds the
 * target by the agent's def handle (resolved to its `toolset` guid, remapped on
 * import like the call family), runs it, and returns the result. The endpoint's
 * `question` input is passed as an object arg via `obj({...})` — a dynamic object
 * value — landing in the agent's `$args` namespace, so `{{ $args.question }}` in
 * the prompt above resolves to it at run time.
 *
 * The `as` var is the rich result ENVELOPE, not the completion — the model's text
 * is at **`.result`** (alongside `finishReason`, `providerMetadata`, `steps`, …).
 * So return `ref("answer.result")` to ship the text; returning `ref("answer")`
 * bare would ship the whole metadata object. `{ safe: true }` makes the nested
 * access null-safe. `ref("answer")` is typed as `AgentRunResult`, so
 * `InferResponse` sees the real shape either way.
 */
export const askAssistant = query({
  name: "ex_ask_assistant",
  verb: "POST",
  apiGroup: api,
  input: { question: input.text({ required: true }) },
  stack: [s.ai.agent.run({ agent: assistant, args: obj({ question: inp("question") }), as: "answer" })],
  response: { text: ref("answer.result", { safe: true }) },
  responseShape: { text: "" as string },
});

/**
 * Gate 4 — deriving the MCP server's endpoint URL from the def (no hardcoding).
 * `getUrl(host)` resolves the pinned `canonical` into the Streamable HTTP URL a
 * client connects to; `getPath()` is the host-relative form. The default token
 * segment `mcp` means "no URL auth" (pass a Bearer `Authorization` header, or
 * embed a token via `getUrl(host, { token })`). Agents are not externally
 * addressable, so `agent()` exposes only `getCanonical()`, not a URL.
 */
export const exampleMcpUrl = exampleMcpServer.getUrl("https://your-instance.dev.xano.io");
export const exampleAgentCanonical = assistant.getCanonical();
