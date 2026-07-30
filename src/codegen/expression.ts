/**
 * Boolean-expression inverse — the engine's `{expression: […]}` tree back to the
 * `expr` / `cmp` / `and` / `or` algebra.
 *
 * One inverse for every surface that emits the tree: conditionals, `while`,
 * `precondition`, table `where`, the `array.*` predicate, and the db search
 * family. The encoder consolidated these into a single algebra precisely so the
 * two historical encoders could not re-diverge; decoding them in one place keeps
 * that property.
 *
 * The `or` flag lives on each *sibling*, not on the container: `encodeContainer`
 * writes `or = joinOr && i > 0`, so a container is uniformly ANDed or uniformly
 * ORed and the flag on the second child is what reveals which. A container with
 * a single child is genuinely ambiguous — both `and(x)` and `or(x)` encode
 * identically — so it decodes to the AND form, which is correct by construction
 * rather than by guess.
 */
import type { ExprNode } from "../types/xdo.js";
import type { TaggedValue } from "../types/xdo.js";
import { CORE_MODULE, type DecodeContext } from "./context.js";
import { arr, call, lit, obj, type Expr } from "./print.js";
import { decodeValue } from "./value.js";

/** The narrow operators `expr()` accepts; anything else needs `cmp()`. */
const NARROW_OPS = new Set(["=", "!=", ">", "<", ">=", "<="]);

/** A decoded expression tree: the source form and the runtime condition. */
export interface DecodedCondition {
  readonly expr: Expr;
  readonly runtime: unknown;
}

/** Coerce a stored `{operand, tag, filters}` to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const operand = raw as { operand?: unknown; tag?: unknown; filters?: unknown };
  if (typeof operand.tag !== "string" || operand.operand === undefined) return null;
  return {
    value: operand.operand as string,
    tag: operand.tag as TaggedValue["tag"],
    filters: (Array.isArray(operand.filters) ? operand.filters : []) as TaggedValue["filters"],
  };
}

/**
 * An empty condition container, in either stored spelling.
 *
 * A half-configured `if`/`while` — dropped into a stack and never given a
 * condition — stores `{expression: []}` (9 real statements) or the empty
 * associative-map form `[]` (8 more). Both mean the same "nothing configured",
 * and both are AUTHORABLE: `Condition` is `SearchNode | SearchNode[]`, and
 * `encodeComparison([])` produces exactly `{expression: []}`. So the empty
 * condition round-trips byte-for-byte — nothing is invented and nothing the
 * engine evaluates changes.
 */
export function isEmptyCondition(block: unknown): boolean {
  if (Array.isArray(block)) return block.length === 0;
  const expression = (block as { expression?: unknown })?.expression;
  return Array.isArray(expression) && expression.length === 0;
}

/**
 * {@link decodeCondition}, plus the empty container it declines.
 *
 * Kept separate so only the surfaces whose factory takes a whole `Condition`
 * (`if`, `while`, an `elif` branch) recover an empty one. A `db.query` search
 * has its own empty handling and must not start emitting `where: []`.
 */
export function decodeConditionOrEmpty(
  ctx: DecodeContext,
  block: unknown,
): DecodedCondition | null {
  if (isEmptyCondition(block)) return { expr: arr([]), runtime: [] };
  return decodeCondition(ctx, block);
}

/** Decode one comparison node. */
function decodeStatementNode(ctx: DecodeContext, node: ExprNode): DecodedCondition | null {
  const statement = (node as { statement?: { op?: unknown; left?: unknown; right?: unknown } })
    .statement;
  if (!statement || typeof statement.op !== "string") return null;

  const left = toValue(statement.left);
  const right = toValue(statement.right);
  if (!left || !right) return null;

  const ignoreEmpty = (statement.right as { ignore_empty?: unknown }).ignore_empty === true;
  const leftExpr = decodeValue(ctx, left);
  const rightExpr = decodeValue(ctx, right);

  // `expr()` is the discoverable narrow form; `cmp()` is required for the wider
  // operator set and for `ignoreEmpty`, which `expr()` has no slot for.
  if (NARROW_OPS.has(statement.op) && !ignoreEmpty) {
    ctx.use(CORE_MODULE, "expr");
    return {
      expr: call("expr", leftExpr, lit(statement.op), rightExpr),
      runtime: { left, op: statement.op, right },
    };
  }

  ctx.use(CORE_MODULE, "cmp");
  const args: Expr[] = [leftExpr, lit(statement.op), rightExpr];
  if (ignoreEmpty) args.push(obj([["ignoreEmpty", lit(true)]]));
  return {
    expr: call("cmp", ...args),
    runtime: { left, op: statement.op, right, ...(ignoreEmpty ? { ignoreEmpty: true } : {}) },
  };
}

/** Decode a sibling list, which is uniformly ANDed or uniformly ORed. */
function decodeContainer(ctx: DecodeContext, nodes: readonly ExprNode[]): DecodedCondition[] | null {
  const out: DecodedCondition[] = [];
  for (const node of nodes) {
    const decoded =
      (node as { type?: unknown }).type === "group"
        ? decodeGroup(ctx, node)
        : decodeStatementNode(ctx, node);
    if (!decoded) return null;
    out.push(decoded);
  }
  return out;
}

/** Decode a `{type:"group"}` node into `and(...)` / `or(...)`. */
function decodeGroup(ctx: DecodeContext, node: ExprNode): DecodedCondition | null {
  const children = (node as { group?: { expression?: unknown } }).group?.expression;
  if (!Array.isArray(children)) return null;
  const decoded = decodeContainer(ctx, children as ExprNode[]);
  if (!decoded) return null;

  // The second sibling's `or` flag is what distinguishes the two join modes; a
  // one-child group cannot express the difference and either form re-encodes
  // identically, so it takes the AND form.
  const joinOr = (children[1] as { or?: unknown } | undefined)?.or === true;
  const helper = joinOr ? "or" : "and";
  ctx.use(CORE_MODULE, helper);
  return {
    expr: call(helper, ...decoded.map((d) => d.expr)),
    runtime: { or: joinOr, children: decoded.map((d) => d.runtime) },
  };
}

/**
 * Decode a stored `{expression: […]}` block into a `Condition`.
 *
 * Top-level siblings are always ANDed (`encodeExpression` passes `joinOr:false`),
 * so a single node decodes bare and several decode to the flat array form.
 */
export function decodeCondition(ctx: DecodeContext, block: unknown): DecodedCondition | null {
  const expression = (block as { expression?: unknown })?.expression;
  if (!Array.isArray(expression)) return null;
  if (expression.length === 0) return null;

  const decoded = decodeContainer(ctx, expression as ExprNode[]);
  if (!decoded) return null;

  // Root siblings carry their own join, exactly like a group's do. A flat ORed
  // root is spelled `or(...)`; the array form means ANDed, so reading an ORed
  // container as an array would quietly change what it means.
  const nodes = expression as Array<{ or?: unknown }>;
  const ored = nodes.map((node, i) => i > 0 && node?.or === true);
  if (nodes[0]?.or === true) return null;
  if (ored.some(Boolean)) {
    // A mixed container (`a AND b OR c`) has no authored form — `or(...)` would
    // re-encode every sibling as ORed. Decline instead of emitting the wrong join.
    if (!ored.slice(1).every(Boolean)) return null;
    ctx.use(CORE_MODULE, "or");
    return {
      expr: call("or", ...decoded.map((d) => d.expr)),
      runtime: { or: true, children: decoded.map((d) => d.runtime) },
    };
  }
  if (decoded.length === 1) return decoded[0]!;
  return {
    expr: arr(decoded.map((d) => d.expr)),
    runtime: decoded.map((d) => d.runtime),
  };
}
