import { describe, it, expect } from "vitest";
import { agent, encodeAgent } from "../../src/kinds/agent.js";
import { mcpServer } from "../../src/kinds/mcp-server.js";
import { Xano } from "../../src/workspace/xano.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { normalize, loadFixture } from "../conformance/harness.js";

describe("agent kind — real agent_settings wire shape", () => {
  it("xano-free: snake_case top-level + configs.xano-free (no apiKey/model)", () => {
    const a = encodeAgent({
      name: "assistant",
      llm: { type: "xano-free", systemPrompt: "be helpful", maxSteps: 5, prompt: "hi" },
    });
    expect(a.type).toBe("agent");
    const s = a.agent_settings;
    expect(s.type).toBe("xano-free");
    expect(s.system_prompt).toBe("be helpful");
    expect(s.max_steps).toBe(5);
    expect(s.prompt_type).toBe("prompt");
    expect(s.prompt).toBe("hi");
    expect(s.prompt_messages).toBe("");
    // xano-free config omits apiKey/model (it's a Google-GenAI wrapper).
    const cfg = s.configs["xano-free"]!;
    expect(cfg).toBeDefined();
    expect("apiKey" in cfg).toBe(false);
    expect("model" in cfg).toBe(false);
    expect(cfg.useSearchGrounding).toBe(false);
    expect(cfg.thinkingConfig).toEqual({ includeThoughts: false, thinkingBudget: 0 });
  });

  it("anthropic: provider config nested under configs.anthropic with camelCase keys", () => {
    const a = encodeAgent({
      name: "a",
      llm: {
        type: "anthropic",
        apiKey: "sk-abc",
        model: "claude-4-sonnet-20250514",
        temperature: 0.7,
        sendReasoning: false,
        thinkingTokens: 2048,
        baseURL: "https://x.test",
      },
    });
    const cfg = a.agent_settings.configs.anthropic!;
    expect(cfg).toEqual({
      apiKey: "sk-abc",
      model: "claude-4-sonnet-20250514",
      temperature: 0.7,
      sendReasoning: false,
      thinking: { type: "enabled", budgetTokens: 2048 },
      baseURL: "https://x.test",
      headers: "",
    });
    // No snake_case api_key leaked to the wire.
    expect("api_key" in cfg).toBe(false);
  });

  it("anthropic: omitting thinkingTokens yields a disabled thinking block", () => {
    const a = encodeAgent({ name: "a", llm: { type: "anthropic" } });
    expect(a.agent_settings.configs.anthropic!.thinking).toEqual({ type: "disabled", budgetTokens: "" });
    // Defaults: sendReasoning true, temperature 1, compatibility n/a.
    expect(a.agent_settings.configs.anthropic!.sendReasoning).toBe(true);
    expect(a.agent_settings.configs.anthropic!.temperature).toBe(1);
  });

  it("openai: reasoningEffort + compatibility defaults, no configs smuggling", () => {
    const a = encodeAgent({
      name: "a",
      llm: { type: "openai", apiKey: "sk", model: "gpt-5-mini", baseURL: "https://p.test" },
    });
    const cfg = a.agent_settings.configs.openai!;
    expect(cfg.apiKey).toBe("sk");
    expect(cfg.reasoningEffort).toBe("medium");
    expect(cfg.compatibility).toBe("strict");
    expect(cfg.baseURL).toBe("https://p.test");
  });

  it("messages prompt maps to prompt_type:'messages' + prompt_messages", () => {
    const a = encodeAgent({ name: "a", llm: { type: "xano-free", messages: "[{...}]" } });
    expect(a.agent_settings.prompt_type).toBe("messages");
    expect(a.agent_settings.prompt_messages).toBe("[{...}]");
    expect(a.agent_settings.prompt).toBe("");
  });

  it("structured output emits camelCase structuredOutputs/structuredOutputsSchema", () => {
    const schema = [{ name: "answer", type: "text" }];
    const a = encodeAgent({ name: "a", llm: { type: "xano-free" }, output: { schema } });
    const s = a.agent_settings as unknown as Record<string, unknown>;
    expect(s.structuredOutputs).toBe(true);
    expect(s.structuredOutputsSchema).toEqual(schema);
    // #85.3 guard: the snake_case forms never reach the wire.
    expect("structured_outputs" in s).toBe(false);
    expect("structured_outputs_schema" in s).toBe(false);
  });

  it("no output → structuredOutputs false, empty schema", () => {
    const a = encodeAgent({ name: "a", llm: { type: "xano-free" } });
    expect(a.agent_settings.structuredOutputs).toBe(false);
    expect(a.agent_settings.structuredOutputsSchema).toEqual([]);
  });

  it("agents have no `instructions` field (stays empty on the wire)", () => {
    const a = encodeAgent({ name: "a", llm: { type: "xano-free" } });
    expect(a.instructions).toBe("");
  });

  it("extraConfig merges into configs.<provider> last (forward-compat)", () => {
    const a = encodeAgent({ name: "a", llm: { type: "openai", extraConfig: { futureField: 1 } } });
    expect(a.agent_settings.configs.openai!.futureField).toBe(1);
  });

  it("requires name and llm", () => {
    // @ts-expect-error - missing name
    expect(() => encodeAgent({ llm: { type: "xano-free" } })).toThrow("agent: `name` is required.");
    // @ts-expect-error - missing llm
    expect(() => encodeAgent({ name: "a" })).toThrow("agent: `llm` is required.");
  });

  it("registers under 'toolset' with a md5('toolset:'+name) guid", () => {
    const bundle = new Xano().registerAgents([agent({ name: "assistant", llm: { type: "xano-free" } })]).export();
    expect(bundle.payload.toolset).toHaveLength(1);
    const obj = (bundle.payload.toolset as Array<Record<string, unknown>>)[0]!;
    expect(obj.type).toBe("agent");
    expect(obj.guid).toBe(deriveGuid("toolset", "assistant"));
  });

  it("an mcpServer and an agent with the same name collide (shared toolset namespace)", () => {
    const x = new Xano()
      .registerMcpServers([mcpServer({ name: "dup" })])
      .registerAgents([agent({ name: "dup", llm: { type: "xano-free" } })]);
    expect(() => x.export()).toThrow(/[Dd]uplicate.*guid/);
  });

  // Locks the openai `agent_settings` wire shape against the engine-authored
  // golden (KTD-6): provider config nests under `configs.openai` with camelCase
  // keys, the top-level `model:""`/`temperature` string-serialization artifacts
  // are absorbed by normalize, and the snake_case envelope matches byte-for-byte.
  it("openai agent_settings deep-equals the engine golden", () => {
    const a = encodeAgent({
      name: "openai",
      llm: {
        type: "openai",
        apiKey: "test",
        model: "gpt-5-mini",
        temperature: 1,
        reasoningEffort: "medium",
        baseURL: "test",
        organization: "test",
        project: "test",
        headers: "test",
        compatibility: "strict",
        systemPrompt:
          "You are a helpful AI Agent that completes tasks accurately. When you need additional information to complete a task, use the available tools. Always explain your reasoning and provide clear responses.",
        maxSteps: 5,
      },
    });
    const golden = loadFixture<{ agent_settings: unknown }>("toolset/agent.json");
    expect(normalize(a.agent_settings)).toEqual(normalize(golden.agent_settings));
  });
});
