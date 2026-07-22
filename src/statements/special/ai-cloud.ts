/**
 * Hand-authored AI-agent and cloud-job specials (U10). All carry `!class`
 * transforms in the engine (AgentRun, CloudJob, CloudJobAwait, CloudJobStatus).
 * The stored shapes here are modeled on those transforms' `decode()` methods
 * (authoritative for the persisted form), so they're grounded — but still have
 * no golden fixture to deep-equal against.
 *
 * @TODO(byte-verify): no transform-temp golden for call_agent / cloud_job{,_await,
 *   _status}. Shapes are now decode()-accurate (agent: context.toolset.id + top-level
 *   runtime + input[]; cloud jobs: everything in input[]), but unconfirmed details
 *   remain: input[] entry ORDER, whether `runtime` is emitted when mode is the
 *   default "shared", and CloudJobArgs.await ("default 60" in docs, not defaulted).
 */
import type { Statement } from "../statement.js";
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

export interface AiAgentRunArgs {
  /** The target agent (toolset of type agent — def handle or name). */
  agent: ObjectRef;
  as?: string;
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
}

/**
 * `ai.agent.run <agent>` — invoke an AI agent (`mvp:call_agent`). Stored shape
 * from `AgentRun::decode`: the target is `context.toolset.id`, `runtime` is a
 * TOP-LEVEL `{ mode }` block, and `args`/`allow_tool_execution`/`version` are
 * `input[]` entries (NOT context). `runtime` is emitted only when a mode is set.
 */
export function aiAgentRun(a: AiAgentRunArgs): Statement {
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
  return stmt;
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
 * shape from `CloudJob::decode`: every block (image/command/args/secret/template/
 * await) is an `input[]` entry; `context` is empty.
 *
 * @TODO(byte-verify): no golden — input[] entry ORDER is a guess (emitted
 *   image→command→args→secret→template→await); confirm against a fixture.
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
 * `ids`/`timeout` are `input[]` entries with empty context (`CloudJobAwait::decode`).
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
 * `id` is an `input[]` entry with empty context (`CloudJobStatus::decode`).
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
