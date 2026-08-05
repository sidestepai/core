/**
 * Workflow test (end-to-end test) kind → payload key `workflow_test`. A named
 * stack with NO input and NO response: it invokes other workspace objects
 * (`s.function.call`, `s.task.call`, `s.api.call`, …) and asserts on the results
 * with `s.expect.*`. Structurally a `task` without a schedule, which is why this
 * file mirrors `task.ts` rather than the function envelope — there is no
 * `input`, `result`, `cache`, `middleware`, or `history` on this kind.
 *
 * ## The datasource is the hazard
 *
 * `datasource: ""` (the default) runs against an EMPTY datasource — what the
 * Xano UI labels "empty (recommended)". A non-empty value names a datasource
 * that the engine **clones** before running the test. Cloning a production-sized
 * datasource is slow enough to fail the run outright, so `""` is the only
 * default worth having and `"live"` warns at encode time.
 */
import type { StackItemXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";

export interface WorkflowTestDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /**
   * Datasource to run against. `""` (the default) means an EMPTY datasource —
   * the recommended setting. Any other value names a datasource the engine
   * **clones** before the test runs; `"live"` warns at encode time.
   */
  datasource?: string;
  /** Whether the test is enabled. Defaults to `true` (the engine's own default). */
  active?: boolean;
  tags?: string[];
  /**
   * The test body: runs (`s.function.call`, `s.task.call`, …) interleaved with
   * assertions (`s.expect.*`). A workflow test takes no input and returns no
   * response — assert on what the runs bind with `as`.
   */
  stack?: Statement[];
}

export interface WorkflowTestXdo {
  name: string;
  description: string;
  docs: string;
  datasource: string;
  active: boolean;
  tag: Array<{ tag: string }>;
  run: StackItemXdo[];
}

/**
 * Warn when a test is pointed at the live datasource. Running a test clones the
 * named datasource first, so this is the one setting that can turn a test run
 * into a production-scale copy.
 *
 * Deliberately narrow: warning on EVERY non-empty datasource would fire on
 * legitimate fixture datasources and train the warning away. `"live"` is the
 * value that reliably means production. It is only ever a warning — `"live"` is
 * a workspace-renameable label, so the SDK has no standing to refuse it.
 */
function warnLiveDatasource(name: string, datasource: string): void {
  if (datasource.trim().toLowerCase() !== "live") return;
  console.warn(
    `sidestep: workflow test "${name}" runs against the "live" datasource. ` +
      `Running a test CLONES its datasource first — against production-sized data ` +
      `this is slow enough to fail the run. Prefer \`datasource: ""\` (an empty ` +
      `datasource, the recommended default) or a small fixture datasource.`,
  );
}

/** Encode a `WorkflowTestDef` into the flattened importable `workflow_test` xdo. */
export function encodeWorkflowTest(def: WorkflowTestDef): WorkflowTestXdo {
  if (!def.name) throw new Error("workflow test: `name` is required.");
  const datasource = def.datasource ?? "";
  warnLiveDatasource(def.name, datasource);
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    datasource,
    active: def.active ?? true,
    tag: encodeTags(def.tags),
    run: (def.stack ?? []).map(encodeStatement),
  };
}

export const workflowTestKind: ObjectKind<WorkflowTestDef, WorkflowTestXdo> = {
  name: "workflow_test",
  payloadKey: "workflow_test",
  encode: encodeWorkflowTest,
};
registerKind(workflowTestKind);

/**
 * Declare an end-to-end test. Register it with `Xano.registerWorkflowTests`.
 *
 * The body is always the same shape: `.call` something and bind it with `as`,
 * then assert on that variable. `s.expect.*` is only meaningful here.
 *
 * ```ts
 * workflowTest({
 *   name: "signup_works",
 *   // datasource omitted — "" is an EMPTY datasource, and cloning a real one
 *   // before every run is slow enough to fail the run.
 *   stack: [
 *     s.function.call({ fn: createUser, input: { email: "a@b.c" }, as: "created" }),
 *     s.expect.to_equal({ expr: ref("created.status"), value: c.text("ok") }),
 *   ],
 * });
 * ```
 */
export function workflowTest(def: WorkflowTestDef): WorkflowTestDef {
  return def;
}
