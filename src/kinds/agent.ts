/**
 * AI agent (`agent`) — a first-class root primitive: an LLM orchestrator that
 * runs a provider model over a set of tools. Persists as `obj_type=toolset` with
 * `type:"agent"` (shares the `toolset` payload section + `md5("toolset:"+name)`
 * guid with MCP servers).
 *
 * The value here over a verbatim `agent_settings` passthrough is a **typed,
 * ergonomic authoring surface that maps onto the engine's real stored shape**.
 * That shape was verified field-by-field against `cloud-client`
 * `transform/Agent.php` + the stored `schema:agent` fixtures, and it is
 * decidedly *not* flat snake_case (contra issue #85's premise):
 *
 *   agent_settings = {
 *     type, system_prompt, max_steps, prompt_type, prompt, prompt_messages,  // top-level snake_case
 *     structuredOutputs, structuredOutputsSchema,                            // top-level CAMELCASE
 *     configs: { <provider>: { …camelCase keys… } },                        // provider config, CAMELCASE
 *   }
 *
 * So `encodeAgent` maps ergonomic authoring fields onto that exact shape:
 * top-level snake_case, the two structured-output keys camelCase, and the
 * provider config nested under `configs.<provider>` with the engine's camelCase
 * keys (`apiKey`, `sendReasoning`, `thinking.budgetTokens`, `useSearchGrounding`,
 * `reasoningEffort`, …). `xano-free` is a Google-GenAI wrapper minus
 * `apiKey`/`model`. Agents have **no** `instructions` field (the transform has
 * none) and no toolset-level middleware.
 *
 * @TODO(byte-verify): the wire shape is hand-modeled from the transform +
 * fixtures, not a golden export deep-equal (KTD-6). Lock it with a fixture when
 * an engine-authored agent export is available.
 *
 * ## Templating: how run inputs reach the agent
 *
 * At run time Xano renders the agent's **string** settings through Twig
 * (`MCP::runCallAgent`, cloud-client) *before* the LLM call, so config values
 * are dynamic per invocation. Two variable namespaces are exposed:
 *   - `$args` — the `args` object passed to `s.ai.agent.run({ args })` (the
 *     `mvp:call_agent` input). This is where an endpoint's inputs enter the agent.
 *   - `$env` — workspace environment variables.
 *
 * Write placeholders as `{{ $args.propertyName }}` / `{{ $env.NAME }}` (full
 * Twig: nesting `{{ $args.user.email }}`, indexing `{{ $args.items[0] }}`,
 * filters `{{ $args.q|upper }}`). Templated fields: `systemPrompt`, `prompt` /
 * `messages`, `model`, `maxSteps`, and every **string** provider-config field
 * (`apiKey`, `baseURL`, `headers`, `model`, `organization`, `project`,
 * `reasoningEffort`, …). Numeric/boolean fields (notably `temperature`) are
 * NOT templated — they're stored as typed literals. So an author references a
 * run input like:
 *
 * ```ts
 * agent({ name: "greeter", llm: {
 *   type: "xano-free",
 *   systemPrompt: "You greet {{ $args.name }} in {{ $args.locale }}.",
 * }});
 * // invoked via: s.ai.agent.run({ agent: greeter, args: obj({ name: inp("name"), locale: c.text("en") }) })
 * ```
 */
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeToolsetBase } from "./toolset.js";
import type { ToolsetBaseXdo, ToolsetToolRef } from "./toolset.js";

/** The LLM provider — the `agent_settings.type` value and the `configs` key. */
export type LlmProvider = "xano-free" | "openai" | "anthropic" | "google-genai";

/**
 * Fields common to every provider's LLM settings. String fields accept Twig
 * placeholders (`{{ $args.x }}` for run inputs, `{{ $env.X }}` for env vars) —
 * see the module header for the full templating contract.
 */
interface LlmCommon {
  /** The agent's system prompt (`agent_settings.system_prompt`). Templatable. */
  systemPrompt?: string;
  /** Max reasoning/tool steps (`agent_settings.max_steps`). Defaults to 5. */
  maxSteps?: number;
  /** A single prompt string (`prompt_type:"prompt"`). Templatable. Mutually exclusive with `messages`. */
  prompt?: string;
  /** A messages template (`prompt_type:"messages"`). Templatable. Mutually exclusive with `prompt`. */
  messages?: string;
  /**
   * Forward-compat escape hatch: extra keys merged into `configs.<provider>`
   * last (for engine fields added after this typing). Prefer the typed fields.
   */
  extraConfig?: Record<string, unknown>;
}

/** Anthropic provider settings → `configs.anthropic`. */
export interface AnthropicLlm extends LlmCommon {
  type: "anthropic";
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** Include reasoning in the response (stored `sendReasoning`). Defaults to true. */
  sendReasoning?: boolean;
  /** Extended-thinking token budget — presence enables `thinking` (`thinking.budgetTokens`). */
  thinkingTokens?: number;
  baseURL?: string;
  headers?: string;
}

/** OpenAI provider settings → `configs.openai`. */
export interface OpenAiLlm extends LlmCommon {
  type: "openai";
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** `configs.openai.reasoningEffort` (e.g. "low" | "medium" | "high"). Defaults to "medium". */
  reasoningEffort?: string;
  baseURL?: string;
  headers?: string;
  organization?: string;
  project?: string;
  /** `configs.openai.compatibility` (e.g. "strict"). Defaults to "strict". */
  compatibility?: string;
}

/** Google GenAI provider settings → `configs.google-genai`. */
export interface GoogleGenAiLlm extends LlmCommon {
  type: "google-genai";
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** Stored `useSearchGrounding`. */
  searchGrounding?: boolean;
  /** Stored `thinkingConfig.thinkingBudget`. */
  thinkingBudget?: number;
  /** Stored `thinkingConfig.includeThoughts`. */
  includeThoughts?: boolean;
  baseURL?: string;
  headers?: string;
  safetySettings?: string;
  /** Stored `dynamicRetrievalConfig` (note: the engine's XanoScript field is misspelled `dynamic_retrival`). */
  dynamicRetrieval?: string;
}

/** Xano Free provider settings → `configs.xano-free` (a Google-GenAI wrapper with no `apiKey`/`model`). */
export interface XanoFreeLlm extends LlmCommon {
  type: "xano-free";
  temperature?: number;
  searchGrounding?: boolean;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  baseURL?: string;
  headers?: string;
  safetySettings?: string;
  dynamicRetrieval?: string;
}

/** Typed LLM settings, discriminated by provider `type`. */
export type LlmSettings = AnthropicLlm | OpenAiLlm | GoogleGenAiLlm | XanoFreeLlm;

/**
 * Structured-output authoring. `schema` is the stored `structuredOutputsSchema`
 * (an array of Xano schema items). Left as `unknown[]` pending the golden
 * fixture that locks the item shape (KTD-6); passed through verbatim.
 */
export interface AgentOutput {
  schema: unknown[];
  /** Whether structured output is enabled (`structuredOutputs`). Defaults to true. */
  enabled?: boolean;
}

/**
 * Agent authoring def. Note: no `instructions`/`spec` — Xano's `Agent`
 * transform has neither.
 */
export interface AgentDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  enabled?: boolean;
  canonical?: string;
  tags?: string[];
  tools?: ToolsetToolRef[];
  /** The typed LLM settings (provider + model + generation config). */
  llm: LlmSettings;
  /** Optional structured output schema. */
  output?: AgentOutput;
}

/** The stored `agent_settings` block — the real engine shape (see module header). */
export interface AgentSettingsXdo {
  type: LlmProvider;
  system_prompt: string;
  max_steps: number;
  prompt_type: "prompt" | "messages";
  prompt: string;
  prompt_messages: string;
  structuredOutputs: boolean;
  structuredOutputsSchema: unknown[];
  configs: Record<string, Record<string, unknown>>;
}

export interface AgentXdo extends ToolsetBaseXdo {
  type: "agent";
  agent_settings: AgentSettingsXdo;
}

/** Build the `configs.<provider>` block with the engine's camelCase keys. */
function buildProviderConfig(llm: LlmSettings): Record<string, unknown> {
  let config: Record<string, unknown>;
  switch (llm.type) {
    case "anthropic":
      config = {
        apiKey: llm.apiKey ?? "",
        model: llm.model ?? "",
        temperature: llm.temperature ?? 1,
        sendReasoning: llm.sendReasoning ?? true,
        thinking:
          llm.thinkingTokens !== undefined
            ? { type: "enabled", budgetTokens: llm.thinkingTokens }
            : { type: "disabled", budgetTokens: "" },
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
      };
      break;
    case "openai":
      config = {
        apiKey: llm.apiKey ?? "",
        model: llm.model ?? "",
        temperature: llm.temperature ?? 1,
        reasoningEffort: llm.reasoningEffort ?? "medium",
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
        organization: llm.organization ?? "",
        project: llm.project ?? "",
        compatibility: llm.compatibility ?? "strict",
      };
      break;
    case "google-genai":
      config = {
        apiKey: llm.apiKey ?? "",
        model: llm.model ?? "",
        temperature: llm.temperature ?? 1,
        useSearchGrounding: llm.searchGrounding ?? false,
        thinkingConfig: {
          includeThoughts: llm.includeThoughts ?? false,
          thinkingBudget: llm.thinkingBudget ?? 0,
        },
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
        safetySettings: llm.safetySettings ?? "",
        dynamicRetrievalConfig: llm.dynamicRetrieval ?? "",
      };
      break;
    case "xano-free":
      // A Google-GenAI wrapper without apiKey/model.
      config = {
        temperature: llm.temperature ?? 1,
        useSearchGrounding: llm.searchGrounding ?? false,
        thinkingConfig: {
          includeThoughts: llm.includeThoughts ?? false,
          thinkingBudget: llm.thinkingBudget ?? 0,
        },
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
        safetySettings: llm.safetySettings ?? "",
        dynamicRetrievalConfig: llm.dynamicRetrieval ?? "",
      };
      break;
  }
  // Forward-compat escape hatch, merged last.
  return llm.extraConfig ? { ...config, ...llm.extraConfig } : config;
}

/** Map the typed authoring def onto the engine's stored `agent_settings`. */
function buildAgentSettings(def: AgentDef): AgentSettingsXdo {
  const llm = def.llm;
  const promptType: "prompt" | "messages" = llm.messages !== undefined ? "messages" : "prompt";
  return {
    type: llm.type,
    system_prompt: llm.systemPrompt ?? "",
    max_steps: llm.maxSteps ?? 5,
    prompt_type: promptType,
    prompt: promptType === "prompt" ? (llm.prompt ?? "") : "",
    prompt_messages: promptType === "messages" ? (llm.messages ?? "") : "",
    structuredOutputs: def.output ? (def.output.enabled ?? true) : false,
    structuredOutputsSchema: def.output?.schema ?? [],
    configs: { [llm.type]: buildProviderConfig(llm) },
  };
}

export function encodeAgent(def: AgentDef): AgentXdo {
  if (!def.name) throw new Error("agent: `name` is required.");
  if (!def.llm) throw new Error("agent: `llm` is required.");
  return {
    ...encodeToolsetBase(def),
    type: "agent",
    agent_settings: buildAgentSettings(def),
  };
}

export const agentKind: ObjectKind<AgentDef, AgentXdo> = {
  name: "agent",
  payloadKey: "toolset",
  encode: encodeAgent,
};
registerKind(agentKind);

/** Author an AI agent — an LLM orchestrator over a set of tools. */
export function agent(def: AgentDef): AgentDef {
  return def;
}
