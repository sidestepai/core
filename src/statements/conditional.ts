/**
 * `conditional` statement (U7) — control flow that proves the registry/base
 * seam generalizes beyond `set_var`: nested `run[]` stacks plus a boolean
 * comparison expression.
 *
 * Stored shape (from the Xano engine's persisted conditional shape):
 *   context: {
 *     expr: { expression: [{ type:"statement", or:false, group:{expression:[]},
 *                            statement:{ op, left, right } }] },
 *     if:   { run: [...statements] },
 *     else: { run: [...statements] },
 *   }
 * Operands use the `operand` key (not `value`). The persisted form does NOT
 * carry `ignore_empty` (optional/`?=false` in the engine schema, dropped at its
 * default on save).
 *
 * The expression algebra (`expr`/`Comparison`/`encodeComparison` + the full
 * `cmp`/`and`/`or` tree) now lives in {@link ./expression.js}; re-exported here
 * so existing `./conditional.js` importers keep resolving.
 */
import type { ConditionalContext, ConditionalElifContext } from "../types/xdo.js";
import type { Statement } from "./statement.js";
import { encodeStatement, registerStatement } from "./statement.js";
import { encodeComparison, type Comparison } from "./expression.js";

export {
  expr,
  encodeComparison,
  encodeSearchExpression,
  type Comparison,
  type ComparisonOp,
} from "./expression.js";

export const CONDITIONAL = "mvp:conditional";
export const CONDITIONAL_ELIF = "mvp:conditional_elif";

/** One `else if (when) { then }` branch of a {@link conditional}'s elif stack. */
export interface ConditionalElifArgs {
  when: Comparison;
  then: Statement[];
}

/**
 * A single elif branch (`mvp:conditional_elif`). Carries its own condition +
 * body but no `else`/nested-`elif` — it's a leaf in the parent conditional's
 * `elif.run` stack, the direct analogue of a `switch_case` under `mvp:switch`.
 */
export function conditionalElif(args: ConditionalElifArgs): Statement {
  const context: ConditionalElifContext = {
    expr: encodeComparison(args.when),
    if: { run: args.then.map(encodeStatement) },
  };
  return { name: CONDITIONAL_ELIF, context, input: [] };
}

export interface ConditionalArgs {
  when: Comparison;
  then: Statement[];
  /** Ordered `else if` branches, each `{ when, then }`. */
  elif?: ConditionalElifArgs[];
  else?: Statement[];
}

/** A branching statement: `if (when) { then } [else if …] else { else }`. */
export function conditional(args: ConditionalArgs): Statement {
  const context: ConditionalContext = {
    expr: encodeComparison(args.when),
    if: { run: args.then.map(encodeStatement) },
    elif: { run: (args.elif ?? []).map((e) => encodeStatement(conditionalElif(e))) },
    else: { run: (args.else ?? []).map(encodeStatement) },
  };
  return { name: CONDITIONAL, context, input: [] };
}

registerStatement(CONDITIONAL, conditional);
registerStatement(CONDITIONAL_ELIF, conditionalElif);
