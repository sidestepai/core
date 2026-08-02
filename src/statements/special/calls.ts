/**
 * Hand-authored call-family block statements (U10) — invoking another workspace
 * object from a stack. These carry `!class` transforms in the engine
 * (FunctionRun, FunctionCall, ApiCall, …) so they're authored by hand.
 *
 * Each stores a **cross-object reference** to its target. In a packageExport
 * bundle that reference is the target's guid (the engine's exportTypeId maps a
 * local id → guid on export); sidestep resolves the authored target → its
 * deterministic guid via `resolveRef` (see refs/guid.ts), so the emitted call
 * and the target object's payload `guid` agree and the import remaps both.
 *
 * Stored shapes (from the Xano engine's persisted context shapes):
 *   function.run     → mvp:function                 ctx { function: { id:<guid> } }   [+input]
 *   function.call    → mvp:workspace_run_function    ctx { id:<guid> }                 [+input]
 *   api.call         → mvp:workspace_run_endpoint     ctx { id:<guid> }                 [+input]
 *   task.call        → mvp:workspace_run_task         ctx { id:<guid> }
 *   tool.call        → mvp:workspace_run_tool         ctx { id:<guid> }                 [+input]
 *   trigger.call     → mvp:workspace_run_trigger      ctx { id:<guid> }                 [+input]
 *   middleware.call  → mvp:workspace_run_middleware   ctx { id:<guid> }                 [+input]
 *   addon.call       → mvp:workspace_run_addon        ctx { id:<guid> }                 [+input]
 *
 * The target object's id resolves to a guid keyed by the engine's migrate
 * *type*: function.run/call → "function", api.call → "query" (an API endpoint
 * is a `query` object), and the rest map name-for-name.
 *
 * Scope: connected-service functions are OUT, permanently — they were never
 * released in Xano, so no engine produces the shape and no workspace can hold
 * one. `mvp:function` therefore has exactly one authoring surface, storing the
 * default payload. Async execution IS modelled (see {@link AsyncRuntime});
 * api.call emits the `headers`/`auth` blocks (verb/name/api_group are
 * engine-derived, not stored).
 *
 * @TODO(byte-verify): `function.run` (mvp:function) and `api.call` (context.token
 *   confirmed tagged) are golden-verified. Still modeled/unverified:
 *   - `workspace_run_*` (cross-workspace calls) — no golden.
 *   - `workflow_test` → context.{datasource,id} — decode-accurate, no golden.
 *   - action / action_package — EXCLUDED from byte-verify: they need an
 *     action-identity model first (action id currently resolves via the "function"
 *     migrate type, likely wrong; action_package is emitted empty). See their own
 *     @TODOs below — do not vendor/capture until the identity model exists.
 */
import type { Statement } from "../statement.js";
import { registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import { coerceScalar } from "./coerce.js";
import { encodeAsyncRuntime } from "./async-runtime.js";
import type { AsyncRuntime } from "./async-runtime.js";
import type { InputValue } from "./coerce.js";

/** A call/agent `{name: value}` input map — raw scalar literals coerce to constants. */
export type CallInput = Record<string, InputValue>;

/** A stored tagged-value triple `{value, tag, filters}`. */
function vf(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

/**
 * Encode a call's `{name: value}` input map into the stored `input[]` entries.
 * Each value is coerced via {@link coerceScalar}, so a raw literal (`{ n: 3 }`)
 * works alongside a tagged {@link Value} (`{ n: inp("n") }`).
 */
function encodeCallInput(input?: CallInput): unknown[] {
  if (!input) return [];
  return Object.entries(input).map(([name, v]) => ({ name, ...vf(coerceScalar(v)) }));
}

/**
 * A call's target function — a def handle or name, or `null` for the engine's own
 * empty binding (`context.function.id: ""`).
 *
 * ⚠ **Do not author `null`.** It is a BROKEN state in Xano, not a neutral one:
 * the statement calls nothing. It exists so `codegen` can represent a broken
 * statement faithfully rather than degrade it to `raw()` — a pulled `fn: null` is
 * a defect to fix in the pulled workspace, not a shape to copy. Same contract as
 * a db statement's `table` and an addon's, which is where the pattern comes from.
 */
type FnRef = ObjectRef | null;

/** A target function's stored id — `""` for an unbound one (see {@link FnRef}). */
function fnId(fn: FnRef): string {
  return fn === null ? "" : resolveRef("function", fn);
}

export interface FunctionRunArgs {
  /** The target function (def handle or name), or `null` when unbound. */
  fn: FnRef;
  /** Capture the result into this stack variable. */
  as?: string;
  /** Input bindings, keyed by the target's input names. */
  input?: CallInput;
  /**
   * Run the function in the background instead of inline. Omit for a normal
   * synchronous call. See {@link AsyncRuntime} — an async call does NOT return
   * the function's result.
   */
  runtime?: AsyncRuntime;
}

/** `function.run <fn>` — run another function inline. */
export function functionRun(args: FunctionRunArgs): Statement {
  return {
    name: "mvp:function",
    context: { function: { id: fnId(args.fn) } },
    as: args.as,
    input: encodeCallInput(args.input),
    runtime: encodeAsyncRuntime(args.runtime),
  };
}

export interface FunctionCallArgs {
  fn: ObjectRef;
  as?: string;
  input?: CallInput;
}

/** `function.call <fn>` — invoke a function as a workspace run. */
export function functionCall(args: FunctionCallArgs): Statement {
  return {
    name: "mvp:workspace_run_function",
    context: { id: resolveRef("function", args.fn) },
    as: args.as,
    input: encodeCallInput(args.input),
  };
}

export interface ApiCallArgs {
  /** The target API endpoint (a `query` object). */
  api: ObjectRef;
  as?: string;
  input?: CallInput;
  /** Override request headers (an assignment value, typically an object). */
  headers?: Value;
  /** Authenticate the call with a token (and optionally ignore its expiry). */
  auth?: { token: Value; ignoreExpiration?: boolean };
}

/**
 * `api.call <endpoint>` — invoke an API endpoint as a workspace run. The stored
 * `context` is `{ id, headers?, token?, token_ignore_expiration? }` (the engine
 * derives name/verb/api_group from the referenced query at encode time, so they
 * are intentionally NOT stored). Shape modeled on the engine's stored api-call format.
 *
 * Golden-verified against a live capture: `context.token` is persisted as a
 * TAGGED `{value,tag,filters}` value (NOT a bare scalar), so the SDK's tagged
 * emission is correct; `token_ignore_expiration` and the tagged `context.headers`
 * match the engine's decode.
 */
export function apiCall(args: ApiCallArgs): Statement {
  const context: Record<string, unknown> = { id: resolveRef("query", args.api) };
  if (args.headers) context.headers = vf(args.headers);
  if (args.auth) {
    context.token = vf(args.auth.token);
    if (args.auth.ignoreExpiration) context.token_ignore_expiration = true;
  }
  return {
    name: "mvp:workspace_run_endpoint",
    context,
    as: args.as,
    input: encodeCallInput(args.input),
  };
}

export interface TaskCallArgs {
  /** The target background task. */
  task: ObjectRef;
  as?: string;
}

/** `task.call <task>` — invoke a task as a workspace run (no input). */
export function taskCall(args: TaskCallArgs): Statement {
  return {
    name: "mvp:workspace_run_task",
    context: { id: resolveRef("task", args.task) },
    as: args.as,
    input: [],
  };
}

export interface ToolCallArgs {
  tool: ObjectRef;
  as?: string;
  input?: CallInput;
}

/** `tool.call <tool>` — invoke a tool as a workspace run. */
export function toolCall(args: ToolCallArgs): Statement {
  return {
    name: "mvp:workspace_run_tool",
    context: { id: resolveRef("tool", args.tool) },
    as: args.as,
    input: encodeCallInput(args.input),
  };
}

export interface TriggerCallArgs {
  trigger: ObjectRef;
  as?: string;
  input?: CallInput;
}

/** `trigger.call <trigger>` — invoke a trigger as a workspace run. */
export function triggerCall(args: TriggerCallArgs): Statement {
  return {
    name: "mvp:workspace_run_trigger",
    context: { id: resolveRef("trigger", args.trigger) },
    as: args.as,
    input: encodeCallInput(args.input),
  };
}

export interface MiddlewareCallArgs {
  middleware: ObjectRef;
  as?: string;
  input?: CallInput;
}

/** `middleware.call <middleware>` — invoke middleware as a workspace run. */
export function middlewareCall(args: MiddlewareCallArgs): Statement {
  return {
    name: "mvp:workspace_run_middleware",
    context: { id: resolveRef("middleware", args.middleware) },
    as: args.as,
    input: encodeCallInput(args.input),
  };
}

export interface AddonCallArgs {
  addon: ObjectRef;
  as?: string;
  input?: CallInput;
}

/** `addon.call <addon>` — invoke an addon as a workspace run. */
export function addonCall(args: AddonCallArgs): Statement {
  return {
    name: "mvp:workspace_run_addon",
    context: { id: resolveRef("addon", args.addon) },
    as: args.as,
    input: encodeCallInput(args.input),
  };
}

// ---------------------------------------------------------------------------
// Call-family tail (structural — no persisted fixture yet).
//
// There is deliberately no `service.function.run` here. Connected-service
// functions were never released, so nothing produces that shape and nothing can
// call one — `mvp:function` has a single surface and the default payload above.
// ---------------------------------------------------------------------------

export interface ActionCallArgs {
  /** The action's name. */
  action: ObjectRef;
  /** The action package identifier. */
  package?: string;
  as?: string;
  input?: CallInput;
}

/**
 * `action.call <action>` — invoke a marketplace/action operation (`mvp:action`).
 * Stored shape from the engine's action-call format: `context.run_version.id` is the action
 * id and `settings_registry` is always present.
 *
 * @TODO(byte-verify): sidestep has no `action` kind, so the id resolves via the
 *   "function" migrate type — likely WRONG (actions are a distinct namespace,
 *   `mapActionNameToId`). input[] uses the lean shape; the engine uses
 *   `convertBlockToInput` (may be the rich form). No golden.
 */
export function actionCall(args: ActionCallArgs): Statement {
  return {
    name: "mvp:action",
    context: { run_version: { id: resolveRef("function", args.action) } },
    as: args.as,
    input: encodeCallInput(args.input),
    settings_registry: [],
  };
}

/**
 * `action.package.call <action>` — invoke an action-package operation
 * (`mvp:action_package`). Stored shape from the engine's action-package format:
 * `context.{action:{trace_id}, package:{slug}, package_version:{id}}`.
 *
 * @TODO(byte-verify): MODELED skeleton only — sidestep doesn't model marketplace
 *   action packages (trace_id / package slug / version id come from
 *   `mapActionPackageNameToId`), so these are emitted EMPTY. This statement is a
 *   reachable placeholder, NOT functional, until the action-package identity model
 *   exists. No golden.
 */
export function actionPackageCall(args: ActionCallArgs): Statement {
  return {
    name: "mvp:action_package",
    context: {
      action: { trace_id: "" },
      package: { slug: args.package ?? "" },
      package_version: { id: "" },
    },
    as: args.as,
    input: encodeCallInput(args.input),
    settings_registry: [],
  };
}

export interface WorkflowTestCallArgs {
  /** The target workflow test. */
  workflowTest: ObjectRef;
  as?: string;
  /** Data source to run against. */
  datasource?: string;
}

/**
 * `workflow_test.call <test>` — run a workflow test
 * (`mvp:workspace_run_workflow_test`). Stored shape from the engine's workflow-test format:
 * `context.{datasource, id}` — `datasource` is ALWAYS present (default `""`).
 */
export function workflowTestCall(args: WorkflowTestCallArgs): Statement {
  return {
    name: "mvp:workspace_run_workflow_test",
    context: {
      datasource: args.datasource ?? "",
      id: resolveRef("workflow_test", args.workflowTest),
    },
    as: args.as,
    input: [],
  };
}

registerStatement("mvp:function", functionRun);
registerStatement("mvp:action", actionCall);
registerStatement("mvp:action_package", actionPackageCall);
registerStatement("mvp:workspace_run_workflow_test", workflowTestCall);
registerStatement("mvp:workspace_run_function", functionCall);
registerStatement("mvp:workspace_run_endpoint", apiCall);
registerStatement("mvp:workspace_run_task", taskCall);
registerStatement("mvp:workspace_run_tool", toolCall);
registerStatement("mvp:workspace_run_trigger", triggerCall);
registerStatement("mvp:workspace_run_middleware", middlewareCall);
registerStatement("mvp:workspace_run_addon", addonCall);
