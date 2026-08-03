/**
 * Hand-authored branching block statements (U10) — `switch` and `try_catch`.
 * Both carry structural control-flow transforms in the engine, so
 * (like `conditional` and the loops) they're authored by hand rather than
 * codegen'd. Each nests `run[]` stacks encoded through the shared statement
 * encoder.
 *
 * Stored shapes (from the Xano engine's persisted switch / try_catch shapes):
 *   switch      → context: { value:<Value>, elif:{ run:[switch_case…] }, else:{ run:[…] } }
 *   switch_case → context: { value:<Value>, break?:bool, if:{ run:[…] } }
 *   try_catch   → context: { if:{ run:[…try…] }, else:{ run:[…catch…] }, then:{ run:[…finally…] } }
 *
 * In `switch`, `value` is the subject being matched and each `switch_case`'s
 * `value` is the literal a case compares against; `else.run` is the `default`
 * block. `break` (fallthrough control) is omitted unless explicitly set, matching
 * the golden fixture. In `try_catch`, the engine maps try→`if`, catch→`else`,
 * finally→`then`; all three blocks are always emitted (engine `exportContext`
 * normalizes each to `{ run: [] }`).
 */
import type { Statement } from "../statement.js";
import type { StatementAnnotations } from "../statement.js";
import { encodeStatement, registerStatement, annotate } from "../statement.js";
import type { Value } from "../../values/value.js";

function valueFields(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

function run(body: Statement[]): unknown[] {
  return body.map(encodeStatement);
}

export interface SwitchCaseArgs extends StatementAnnotations {
  /** The literal this case matches against the switch subject. */
  when: Value;
  /** Statements run when this case matches. */
  body: Statement[];
  /**
   * Whether to stop after this case (`true`) or fall through to the next
   * (`false`). Omitted from the stored shape entirely when not set.
   */
  break?: boolean;
}

/** A single `case (when) { body }` clause of a `switch`. */
export function switchCase(args: SwitchCaseArgs): Statement {
  const context: Record<string, unknown> = { value: valueFields(args.when) };
  if (args.break !== undefined) {
    context.break = args.break;
  }
  context.if = { run: run(args.body) };
  return annotate({ name: "mvp:switch_case", context, input: [] }, args);
}

export interface SwitchArgs extends StatementAnnotations {
  /** The subject value being matched. */
  on: Value;
  /** Ordered `case` clauses. */
  cases: SwitchCaseArgs[];
  /** The `default` block, run when no case matches. */
  default?: Statement[];
}

/** `switch (on) { case … default … }` — multi-way branch. */
export function switchStatement(args: SwitchArgs): Statement {
  return annotate({
    name: "mvp:switch",
    context: {
      value: valueFields(args.on),
      elif: { run: args.cases.map((c) => encodeStatement(switchCase(c))) },
      else: { run: run(args.default ?? []) },
    },
    input: [],
  }, args);
}

export interface TryCatchArgs extends StatementAnnotations {
  /** The protected block (engine `if`). */
  try: Statement[];
  /** Error-handler block (engine `else`). */
  catch?: Statement[];
  /** Always-run block (engine `then`). */
  finally?: Statement[];
}

/** `try_catch { try … catch … finally … }` — error handling block. */
export function tryCatch(args: TryCatchArgs): Statement {
  return annotate({
    name: "mvp:try_catch",
    context: {
      if: { run: run(args.try) },
      else: { run: run(args.catch ?? []) },
      then: { run: run(args.finally ?? []) },
    },
    input: [],
  }, args);
}

registerStatement("mvp:switch", switchStatement);
registerStatement("mvp:switch_case", switchCase);
registerStatement("mvp:try_catch", tryCatch);
