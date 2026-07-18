/**
 * Hand-authored control-flow block statements (U10). These carry `!class` /
 * `!function` transforms in the engine (ForLoop, schema:foreach, schema:while,
 * Group), so they're authored by hand — like `conditional` — rather than
 * codegen'd. Each nests a `run[]` stack encoded through the shared statement
 * encoder, and `while` reuses the conditional's `encodeComparison`.
 *
 * Stored shapes (cloud-client transform-temp/schema:{for,foreach}.json and
 * process/.../DEV-1481-while.json):
 *   for     → context: { as, cnt:<Value>,  run:[…] }
 *   foreach → context: { as, list:<Value>, run:[…] }
 *   while   → context: { expr:<comparison>, run:[…] }
 *   group   → context: { run:[…] }
 *
 * @TODO(byte-verify): `for` and `foreach` ARE golden-verified. `while` and `group`
 *   are MODELED — no transform-temp golden in the corpus (last survey). The `while`
 *   shape is inferred from a process-dir fixture, not a persisted transform-temp one;
 *   confirm `expr` vs the loops' `cnt`/`list` keying, and `group`'s bare `{run}`.
 */
import type { Statement } from "../statement.js";
import { encodeStatement, registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { encodeComparison } from "../conditional.js";
import type { Comparison } from "../conditional.js";

function valueFields(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

function run(body: Statement[]): unknown[] {
  return body.map(encodeStatement);
}

export interface ForArgs {
  /** Loop variable name (the index). */
  as: string;
  /** Iteration count. */
  count: Value;
  body: Statement[];
}

/** `for (as in 0..count) { body }` — count-bounded loop. */
export function forLoop(args: ForArgs): Statement {
  return {
    name: "mvp:for",
    context: { as: args.as, cnt: valueFields(args.count), run: run(args.body) },
    input: [],
  };
}

export interface ForeachArgs {
  /** Loop variable name (the current item). */
  as: string;
  /** The list to iterate. */
  list: Value;
  body: Statement[];
}

/** `foreach (as of list) { body }` — list iteration. */
export function foreachLoop(args: ForeachArgs): Statement {
  return {
    name: "mvp:foreach",
    context: { as: args.as, list: valueFields(args.list), run: run(args.body) },
    input: [],
  };
}

export interface WhileArgs {
  when: Comparison;
  body: Statement[];
}

/** `while (when) { body }` — condition-bounded loop. */
export function whileLoop(args: WhileArgs): Statement {
  return {
    name: "mvp:while",
    context: { expr: encodeComparison(args.when), run: run(args.body) },
    input: [],
  };
}

/** `group { body }` — a labeled block grouping a sub-stack. */
export function group(body: Statement[]): Statement {
  return { name: "mvp:group", context: { run: run(body) }, input: [] };
}

registerStatement("mvp:for", forLoop);
registerStatement("mvp:foreach", foreachLoop);
registerStatement("mvp:while", whileLoop);
registerStatement("mvp:group", group);
