/**
 * Hand-authored AI-agent and cloud-job specials (U10). All carry `!class`
 * transforms in the engine (AgentRun, CloudJob, CloudJobAwait, CloudJobStatus).
 * The stored shapes here are modeled on those transforms' `decode()` methods
 * (authoritative for the persisted form), so they're grounded — but still have
 * no golden fixture to deep-equal against.
 *
 * call_agent and cloud_job{,_await,_status} are golden-verified against live
 * engine captures (see the conformance corpus): agent → context.toolset.id +
 * top-level runtime + input[]; cloud jobs → everything in input[] with the
 * captured entry order. `runtime` is omitted at the default "shared" mode, and
 * `await` is passed through as authored.
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import { registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { isTaggedValue } from "../../values/value.js";
import { obj } from "../../values/obj.js";
import type { ObjInput } from "../../values/obj.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";

function vf(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

/**
 * The rich result object an agent run binds to its `as` variable — modeled on
 * the engine's agent-run result envelope (issue #89). **The completion is at
 * `.result`**, not the top level; the surrounding fields are run metadata.
 *
 * `R` is the completion type: `string` for a text agent (the default — including
 * `xano-free`), or an object when structured outputs (a schema) are enabled.
 * Narrow it with the `resultShape` witness on {@link AiAgentRunArgs}.
 *
 * `finishReasonCandidate`/`toolCalls`/`usage`/`totalUsage` are optional: they are
 * absent or empty depending on the run (no tools, single provider, engine
 * version), so a returned envelope may carry only a subset.
 */
export interface AgentRunResult<R = string> {
  /** The model's completion — the field almost every caller wants. `string` unless structured outputs are enabled (then an object; narrow via `resultShape`). */
  result: R;
  /** Why generation stopped: `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown'`. */
  finishReason: string;
  /** Provider-specific metadata (e.g. usage counters, safety signals), keyed by provider. */
  providerMetadata: Record<string, Record<string, unknown>>;
  /** Reasoning parts emitted by the model; `[]` when none. */
  reasoningDetails: unknown[];
  /** Per-step records (each with e.g. `text`, `finishReason`, `usage`, `toolCalls`, `providerMetadata`). */
  steps: unknown[];
  /** Fallback finish reason, populated only when `finishReason` is `'unknown'`; otherwise empty/absent. */
  finishReasonCandidate?: string;
  /** Merged tool-call + result records; absent or empty when no tools ran. */
  toolCalls?: unknown[];
  /** Token usage for the final generation (`inputTokens`, `outputTokens`, `totalTokens`, …). */
  usage?: Record<string, unknown>;
  /** Token usage aggregated across all steps. */
  totalUsage?: Record<string, unknown>;
}

export interface AiAgentRunArgs<As extends string = "", R = string> {
  /** The target agent (toolset of type agent — def handle or name). */
  agent: ObjectRef;
  /** The stack variable this run binds. Captured literally so `InferResponse` can trace a `ref` back to the typed {@link AgentRunResult}. */
  as?: As;
  /**
   * Run arguments passed to the agent. Pass a single {@link Value}, or an object
   * literal of values (`{ question: inp("question") }`) which is built into a
   * dynamic object via {@link obj}. This becomes the agent's `$args` Twig
   * namespace: the agent's string settings (system prompt, prompt, model,
   * provider config) reference these as `{{ $args.propertyName }}`, resolved per
   * invocation before the LLM call. (Env vars are `{{ $env.NAME }}`.) See
   * `kinds/agent.ts` for the full templating rules.
   */
  args?: Value | ObjInput;
  /** Whether the agent may execute its tools. */
  allowToolExecution?: Value;
  /** Pinned agent version. */
  version?: Value;
  /** Execution mode (`"shared"` default). */
  runtimeMode?: string;
  /**
   * Type-only witness narrowing the `.result` completion type (default `string`).
   * Pass a witness value for a structured-output agent so `ref(as).result` is
   * checkable — e.g. `resultShape: {} as { sentiment: string }`. Never emitted
   * into the statement (phantom, like the response brand).
   */
  resultShape?: R;
}

/**
 * `ai.agent.run <agent>` — invoke an AI agent (`mvp:call_agent`). Stored shape
 * from the engine's agent-run format: the target is `context.toolset.id`, `runtime` is a
 * TOP-LEVEL `{ mode }` block, and `args`/`allow_tool_execution`/`version` are
 * `input[]` entries (NOT context). `runtime` is emitted only when a mode is set.
 *
 * Branded with `AsShapeBrand<As, AgentRunResult<R>>` (like the `db.*` producers)
 * so `ref(as)` traces to the typed {@link AgentRunResult} envelope via
 * `InferResponse` instead of `unknown` — the completion is at `.result` (#89).
 * A dotted `ref("<as>.result")` now projects that completion directly (#93), so
 * the common "return just the answer" endpoint no longer needs a `responseShape`.
 * The brand is phantom; the emitted statement bytes are unchanged.
 */
export function aiAgentRun<const As extends string = "", R = string>(
  a: AiAgentRunArgs<As, R>,
): Statement & AsShapeBrand<As, AgentRunResult<R>> {
  const input: unknown[] = [];
  // `args` accepts a single Value or an object literal of values — a record is
  // built into a dynamic object value (`obj`), so `{ q: inp("q") }` reaches the
  // agent's `$args.q`.
  if (a.args !== undefined) {
    const argsValue = isTaggedValue(a.args) ? a.args : obj(a.args as ObjInput);
    input.push({ name: "args", ...vf(argsValue) });
  }
  if (a.allowToolExecution) input.push({ name: "allow_tool_execution", ...vf(a.allowToolExecution) });
  if (a.version) input.push({ name: "version", ...vf(a.version) });
  const stmt: Statement = {
    name: "mvp:call_agent",
    context: { toolset: { id: resolveRef("toolset", a.agent) } },
    as: a.as ?? "",
    input,
  };
  if (a.runtimeMode) stmt.runtime = { mode: a.runtimeMode };
  return stmt as unknown as Statement & AsShapeBrand<As, AgentRunResult<R>>;
}

export interface CloudJobArgs {
  as?: string;
  image?: Value;
  command?: Value;
  args?: Value;
  secret?: Value;
  template?: Value;
  /** Seconds to await completion (default 60). */
  await?: Value;
}

/**
 * `cloud.job { … }` — launch a containerized cloud job (`mvp:cloud_job`). Stored
 * shape from the engine's cloud-job format: every block (image/command/args/secret/template/
 * await) is an `input[]` entry; `context` is empty.
 *
 * Golden-verified against a live capture: the input[] entry order
 * (image→command→args→secret→template→await) matches the persisted shape.
 */
export function cloudJob(a: CloudJobArgs): Statement {
  const input: unknown[] = [];
  if (a.image) input.push({ name: "image", ...vf(a.image) });
  if (a.command) input.push({ name: "command", ...vf(a.command) });
  if (a.args) input.push({ name: "args", ...vf(a.args) });
  if (a.secret) input.push({ name: "secret", ...vf(a.secret) });
  if (a.template) input.push({ name: "template", ...vf(a.template) });
  if (a.await) input.push({ name: "await", ...vf(a.await) });
  return { name: "mvp:cloud_job", context: {}, as: a.as ?? "", input };
}

export interface CloudJobAwaitArgs {
  as?: string;
  /** Job ids to await. */
  ids: Value;
  /** Timeout in seconds. */
  timeout: Value;
}

/**
 * `cloud.job.await { … }` — wait for cloud jobs to finish (`mvp:cloud_job_await`).
 * `ids`/`timeout` are `input[]` entries with empty context (per the engine's cloud-job-await format).
 */
export function cloudJobAwait(a: CloudJobAwaitArgs): Statement {
  return {
    name: "mvp:cloud_job_await",
    context: {},
    as: a.as ?? "",
    input: [
      { name: "ids", ...vf(a.ids) },
      { name: "timeout", ...vf(a.timeout) },
    ],
  };
}

export interface CloudJobStatusArgs {
  as?: string;
  /** The job id to query. */
  id: Value;
}

/**
 * `cloud.job.status { … }` — read a cloud job's status (`mvp:cloud_job_status`).
 * `id` is an `input[]` entry with empty context (per the engine's cloud-job-status format).
 */
export function cloudJobStatus(a: CloudJobStatusArgs): Statement {
  return {
    name: "mvp:cloud_job_status",
    context: {},
    as: a.as ?? "",
    input: [{ name: "id", ...vf(a.id) }],
  };
}

registerStatement("mvp:call_agent", aiAgentRun);
registerStatement("mvp:cloud_job", cloudJob);
registerStatement("mvp:cloud_job_await", cloudJobAwait);
registerStatement("mvp:cloud_job_status", cloudJobStatus);
