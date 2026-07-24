/**
 * The single boolean-expression algebra shared by every SDK surface that emits
 * the engine's `{ expression: [ … ] }` shape — conditionals, `while`,
 * `precondition`, table `where`, the `array.*` `!compare` predicate, and the
 * db.query/bulk/addon `where` search. Historically this lived in two divergent
 * encoders (`conditional.ts`'s narrow `encodeComparison` and `db-search.ts`'s
 * full-tree `encodeSearch`); consolidating them here keeps the two capability
 * gaps (grouping/full-ops, filtered operands) from ever re-diverging and breaks
 * the old `db-search → conditional` import cycle.
 *
 * The engine node shapes (persisted form):
 *   statement : { type:"statement", or, group:{expression:[]}, statement:{ op, left, right } }
 *   group     : { type:"group",     or, group:{expression:[ …children… ]} }
 *   operand   : { operand, tag, filters }  (+ optional `ignore_empty` on the right)
 *
 * Operands pass their tag/filters straight through — a filtered operand
 * (`withFilters(...)`) is valid inline in every condition/`where` surface
 * (conditional, while, db.query/addon, …), verified against a live engine
 * (the old #118 db-search rejection no longer reproduces).
 */
import type { ExprGroup, ExprNode, ExprOperand, ExprStatement } from "../types/xdo.js";
import type { Value } from "../values/value.js";

// ---------------------------------------------------------------------------
// Narrow comparison — `expr()` (6 operators, single binary comparison). Stays
// the discoverable default; `cmp()` below is the full-operator power surface.
// ---------------------------------------------------------------------------

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

/** Build a single binary comparison for a conditional/while/predicate `when`. */
export function expr(left: Value, op: ComparisonOp, right: Value): Comparison {
  const normalized = (OP_ALIASES as Record<string, EngineOp>)[op] ?? (op as EngineOp);
  if (!SUPPORTED_OPS.includes(normalized)) {
    throw new Error(
      `Unsupported conditional operator "${op}". Supported: ${SUPPORTED_OPS.join(", ")} (also == === !==)`,
    );
  }
  return { left, op: normalized, right };
}

// ---------------------------------------------------------------------------
// Full operator set — `cmp()` — and AND/OR grouping — `and()` / `or()`.
// ---------------------------------------------------------------------------

/**
 * The full engine operator set for a comparison (`op` values from the Xano
 * engine's operator definitions). `cmp(...)` accepts these; the narrow
 * `expr(...)` stays limited to `= != > < >= <=`.
 */
export type SearchOp =
  | "="
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not in"
  | "like"
  | "not like"
  | "ilike"
  | "not ilike"
  | "~"
  | "!~"
  | "between"
  | "not between"
  | "@>"
  | "contains"
  | "not contains"
  | "includes"
  | "not includes"
  | "overlaps"
  | "not overlaps"
  | "search";

const SEARCH_OPS = new Set<string>([
  "=", "==", "!=", "<", "<=", ">", ">=", "in", "not in", "like", "not like", "ilike",
  "not ilike", "~", "!~", "between", "not between", "@>", "contains", "not contains",
  "includes", "not includes", "overlaps", "not overlaps", "search",
]);

/** A comparison over the full {@link SearchOp} set, with an optional `ignore_empty`. */
export interface SearchComparison {
  left: Value;
  op: SearchOp;
  right: Value;
  /** Skip this clause when the resolved right value is empty (engine `right.ignore_empty`). */
  ignoreEmpty?: boolean;
}

/** A nested AND/OR group of nodes (`{type:"group"}`). */
export interface SearchGroup {
  /** How the group's children join each other: OR (`true`) or AND (`false`). */
  or: boolean;
  children: SearchNode[];
}

/** A node in the expression tree: a narrow `expr()`, a full `cmp()`, or an and/or group. */
export type SearchNode = Comparison | SearchComparison | SearchGroup;

/**
 * A boolean condition for a `when`/predicate surface (conditional, while,
 * precondition, array.* `!compare`, table `where`): one node, or a flat array of
 * nodes ANDed together. The full Xano expression tree — a single `expr()` stays
 * the discoverable common case.
 */
export type Condition = SearchNode | SearchNode[];

/**
 * Build a comparison over the full operator set (`in`, `like`, `ilike`,
 * `between`, `contains`, `overlaps`, `@>`, `~`, `search`, …). Distinct from the
 * narrow `expr()`. `opts.ignoreEmpty` skips the clause when the resolved right
 * value is empty.
 */
export function cmp(
  left: Value,
  op: SearchOp,
  right: Value,
  opts?: { ignoreEmpty?: boolean },
): SearchComparison {
  if (!SEARCH_OPS.has(op)) {
    throw new Error(
      `unsupported operator "${op}". Supported: ${[...SEARCH_OPS].join(", ")}.`,
    );
  }
  return { left, op, right, ignoreEmpty: opts?.ignoreEmpty };
}

/** Group nodes joined by AND (`and(a, b, or(c, d))`). */
export function and(...children: SearchNode[]): SearchGroup {
  return { or: false, children };
}

/** Group nodes joined by OR (`or(a, b)`). */
export function or(...children: SearchNode[]): SearchGroup {
  return { or: true, children };
}

// ---------------------------------------------------------------------------
// Node guards.
// ---------------------------------------------------------------------------

/** A tagged {@link Value} (`{value, tag, filters}`) — the raw escape hatch. */
export function isValue(w: unknown): w is Value {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "tag" in w && "value" in w;
}

/** An and/or group node. */
export function isGroup(w: unknown): w is SearchGroup {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "children" in w;
}

/** A comparison node (narrow `expr()` or full `cmp()`) — has `left` + `op`, not a tagged value. */
export function isCmpNode(w: unknown): w is Comparison | SearchComparison {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "op" in w && "left" in w;
}

// ---------------------------------------------------------------------------
// Operand + tree encoding. `encodeContainer`/`toStatementNode` take an
// OperandEncoder so each surface controls operand handling without cloning the
// tree walk.
// ---------------------------------------------------------------------------

/** Encode one operand {@link Value} to the engine `{operand, tag, filters}` shape. */
function toOperand(v: Value): ExprOperand {
  return { operand: v.value, tag: v.tag, filters: v.filters };
}

/** One `{type:"statement", or, group:{expression:[]}, statement:{op,left,right}}` node. */
function toStatementNode(node: Comparison | SearchComparison, or: boolean): ExprStatement {
  const right = toOperand(node.right);
  if ((node as SearchComparison).ignoreEmpty) right.ignore_empty = true;
  return {
    type: "statement",
    or,
    group: { expression: [] },
    statement: { op: node.op, left: toOperand(node.left), right },
  };
}

/**
 * Encode a container of sibling nodes into `expression[]`. `joinOr` decides how
 * siblings after the first join the previous one (the engine's per-node `or`):
 * AND (`false`) for a flat container/`and(...)`, OR (`true`) for `or(...)`. The
 * first sibling never ORs to a nonexistent predecessor.
 */
export function encodeContainer(children: SearchNode[], joinOr: boolean): ExprNode[] {
  return children.map((child, i): ExprNode => {
    const or = joinOr && i > 0;
    if (isGroup(child)) {
      const group: ExprGroup = {
        type: "group",
        or,
        group: { expression: encodeContainer(child.children, child.or) },
      };
      return group;
    }
    return toStatementNode(child, or);
  });
}

/**
 * Encode a single node or a flat (ANDed) array of nodes into the engine's
 * `{ expression: [ … ] }` shape — the one entry point every surface routes through.
 */
export function encodeExpression(input: Condition): { expression: ExprNode[] } {
  const nodes = Array.isArray(input) ? input : [input];
  return { expression: encodeContainer(nodes, false) };
}

/**
 * Encode a single binary comparison into the engine's `{expression:[…]}` shape.
 * Byte-identical to routing the comparison through {@link encodeExpression};
 * kept as a named helper for the conditional/while/`!compare`/table-`where`
 * callers that emit exactly one comparison.
 */
export function encodeComparison(when: Condition): { expression: ExprNode[] } {
  return encodeExpression(when);
}

/**
 * Encode one or more comparisons into the engine's `{expression:[…]}` shape,
 * ANDed together (`or:false`). Same algebra as {@link encodeComparison}, for the
 * query/trigger search surfaces that AND a list of clauses.
 */
export function encodeSearchExpression(clauses: Comparison[]): { expression: ExprNode[] } {
  return encodeExpression(clauses);
}
