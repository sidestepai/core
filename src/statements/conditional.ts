/**
 * `conditional` statement (U7) — control flow that proves the registry/base
 * seam generalizes beyond `set_var`: nested `run[]` stacks plus a minimal
 * binary-comparison expression.
 *
 * Stored shape (from cloud-client transform-temp/schema:conditional.json):
 *   context: {
 *     expr: { expression: [{ type:"statement", or:false, group:{expression:[]},
 *                            statement:{ op, left, right } }] },
 *     if:   { run: [...statements] },
 *     else: { run: [...statements] },
 *   }
 * Operands use the `operand` key (not `value`). The persisted form does NOT
 * carry `ignore_empty` (optional/`?=false` in the engine schema, dropped at its
 * default on save).
 */
import type { ConditionalContext, ExprOperand, ExprStatement } from "../types/xdo.js";
import type { Statement } from "./statement.js";
import { encodeStatement, registerStatement } from "./statement.js";
import type { Value } from "../values/value.js";

export const CONDITIONAL = "mvp:conditional";

const SUPPORTED_OPS = ["=", "!=", ">", "<", ">=", "<="] as const;
type EngineOp = (typeof SUPPORTED_OPS)[number];
/** JS-style operators accepted for ergonomics; normalized to the engine form. */
const OP_ALIASES = { "==": "=", "===": "=", "!==": "!=" } as const;
export type ComparisonOp = EngineOp | keyof typeof OP_ALIASES;

/** A minimal single binary comparison: `left op right`. */
export interface Comparison {
  left: Value;
  op: EngineOp;
  right: Value;
}

/** Build a single binary comparison for a conditional's `when`. */
export function expr(left: Value, op: ComparisonOp, right: Value): Comparison {
  const normalized = (OP_ALIASES as Record<string, EngineOp>)[op] ?? (op as EngineOp);
  if (!SUPPORTED_OPS.includes(normalized)) {
    throw new Error(
      `Unsupported conditional operator "${op}". Supported: ${SUPPORTED_OPS.join(", ")} (also == === !==)`,
    );
  }
  return { left, op: normalized, right };
}

function toOperand(value: Value): ExprOperand {
  return { operand: value.value, tag: value.tag, filters: value.filters };
}

/** Encode one comparison into an `expression[]` `statement` entry. */
function toExprStatement(when: Comparison): ExprStatement {
  return {
    type: "statement",
    or: false,
    group: { expression: [] },
    statement: {
      op: when.op,
      left: toOperand(when.left),
      // The persisted form omits `ignore_empty` on the right operand: the engine
      // schema marks it `?=false` (optional, default false) and drops it at the
      // default on save (verified: 0 occurrences across the live xdo corpus). The
      // older transform-temp parser fixtures still carry it — a cross-generation
      // artifact the conformance normalizer drops on both sides.
      right: toOperand(when.right),
    },
  };
}

/**
 * Encode a single binary comparison into the engine's `{expression:[…]}` shape.
 * Shared with the schema-DSL `!compare` directive (U9) so the conditional and
 * every `!compare`-bearing statement (array.find/every, …) emit one identical
 * expression form.
 */
export function encodeComparison(when: Comparison): { expression: ExprStatement[] } {
  return { expression: [toExprStatement(when)] };
}

/**
 * Encode one or more comparisons into the engine's `{expression:[…]}` search
 * shape, ANDed together (`or:false`). This is the same operand-based expression
 * algebra as {@link encodeComparison} (the conditional `when`) — reused by the
 * query/trigger search surfaces so a filter can be authored with `expr(...)`
 * instead of a hand-built tagged value.
 */
export function encodeSearchExpression(clauses: Comparison[]): { expression: ExprStatement[] } {
  return { expression: clauses.map(toExprStatement) };
}

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
