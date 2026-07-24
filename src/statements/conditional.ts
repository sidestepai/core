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
import type { ConditionalContext } from "../types/xdo.js";
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

export interface ConditionalArgs {
  when: Comparison;
  then: Statement[];
  else?: Statement[];
}

/** A branching statement: `if (when) { then } else { else }`. */
export function conditional(args: ConditionalArgs): Statement {
  const context: ConditionalContext = {
    expr: encodeComparison(args.when),
    if: { run: args.then.map(encodeStatement) },
    else: { run: (args.else ?? []).map(encodeStatement) },
  };
  return { name: CONDITIONAL, context, input: [] };
}

registerStatement(CONDITIONAL, conditional);
