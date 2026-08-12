/**
 * Hand-authored control-flow block statements (U10). These carry non-trivial
 * transforms in the engine (for, foreach, while, group), so they're authored by
 * hand — like `conditional` — rather than codegen'd. Each nests a `run[]` stack
 * encoded through the shared statement encoder, and `while` reuses the
 * conditional's `encodeComparison`.
 *
 * Stored shapes (from the Xano engine's persisted for/foreach/while shapes):
 *   for     → context: { as, cnt:<Value>,  run:[…] }
 *   foreach → context: { as, list:<Value>, run:[…] }
 *   while   → context: { expr:<comparison>, run:[…] }
 *   group   → context: { run:[…] }
 *
 * All four are golden-verified: `for`/`foreach` from vendored goldens, and
 * `while`/`group` from live engine captures (see the conformance corpus). The
 * `while` shape (`expr` comparison + `run[]`) and `group`'s bare `{run}` are
 * confirmed byte-exact.
 */
import type { Statement } from "../statement.js";
import type { StatementAnnotations, StatementOptions } from "../statement.js";
import { encodeStatement, registerStatement, annotate } from "../statement.js";
import type { Value } from "../../values/value.js";
import { encodeComparison } from "../conditional.js";
import type { Condition } from "../conditional.js";

function valueFields(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

function run(body: Statement[]): unknown[] {
  return body.map(encodeStatement);
}

export interface ForArgs extends StatementOptions {
  /** Loop variable name (the index). */
  as: string;
  /** Iteration count. */
  count: Value;
  body: Statement[];
}

/** `for (as in 0..count) { body }` — count-bounded loop. */
export function forLoop(args: ForArgs): Statement {
  return annotate({
    name: "mvp:for",
    context: { as: args.as, cnt: valueFields(args.count), run: run(args.body) },
    input: [],
  }, args);
}

export interface ForeachArgs extends StatementOptions {
  /** Loop variable name (the current item). */
  as: string;
  /** The list to iterate. */
  list: Value;
  body: Statement[];
}

/** `foreach (as of list) { body }` — list iteration. */
export function foreachLoop(args: ForeachArgs): Statement {
  return annotate({
    name: "mvp:foreach",
    context: { as: args.as, list: valueFields(args.list), run: run(args.body) },
    input: [],
  }, args);
}

export interface WhileArgs extends StatementAnnotations {
  when: Condition;
  body: Statement[];
}

/** `while (when) { body }` — condition-bounded loop. */
export function whileLoop(args: WhileArgs): Statement {
  return annotate({
    name: "mvp:while",
    context: { expr: encodeComparison(args.when), run: run(args.body) },
    input: [],
  }, args);
}

/** `group { body }` — a labeled block grouping a sub-stack. */
export function group(body: Statement[], a?: StatementAnnotations): Statement {
  return annotate({ name: "mvp:group", context: { run: run(body) }, input: [] }, a);
}

registerStatement("mvp:for", forLoop);
registerStatement("mvp:foreach", foreachLoop);
registerStatement("mvp:while", whileLoop);
registerStatement("mvp:group", group);
