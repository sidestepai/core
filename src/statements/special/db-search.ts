/**
 * Shared db-search authoring primitives — the `where`/`sort` surface used by
 * both `s.db.query` (`./db.ts`) and a table-bound `addon()`
 * (`../../kinds/addon.ts`). Extracted here so the addon kind can reuse the exact
 * same builders without importing `db.ts` (which imports the addon kind — a
 * cycle).
 */
import type { Value } from "../../values/value.js";
import type { Comparison } from "../conditional.js";

/** Sort direction for a {@link SortDirective} — the engine's `orderBy` values. */
export type SortDir = "asc" | "desc" | "rand";

/**
 * One sort directive: order the returned rows by `sortBy`, ascending, descending,
 * or random. `dir` maps to the engine's `orderBy`; the encoded element is the
 * `mvp_sort` shape `{ sortBy, orderBy }`. Each caller places that element
 * differently — `db.query` under `context.return.list.sort` (via
 * `MVP::convertContextToConfig`), an `addon()` at top-level `context.sort` — so
 * this doc stays placement-neutral; see each caller's own doc for where it lands.
 */
export interface SortDirective<C extends string = string> {
  /** The column (or dot-path) to sort by. */
  sortBy: C;
  /** Direction (`"asc"` | `"desc"` | `"rand"`); defaults to ascending. */
  dir?: SortDir;
}

/**
 * The full engine operator set for a search comparison (`op` values from
 * `x2 …/XS/xs/op/*.php` `getName()`). `cmp(...)` accepts these; the conditional
 * `expr(...)` stays intentionally narrow (`= != > < >= <=`) — see KTD3 in the
 * db.query parity plan.
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

/** A search comparison over the full {@link SearchOp} set, with an optional `ignore_empty`. */
export interface SearchComparison {
  left: Value;
  op: SearchOp;
  right: Value;
  /** Skip this clause when the resolved right value is empty (engine `right.ignore_empty`). */
  ignoreEmpty?: boolean;
}

/** A nested AND/OR group of search nodes (`context.search.expression` `{type:"group"}`). */
export interface SearchGroup {
  /** How the group's children join each other: OR (`true`) or AND (`false`). */
  or: boolean;
  children: SearchNode[];
}

/** A node in the search tree: a narrow `expr()` comparison, a `cmp()` comparison, or an and/or group. */
export type SearchNode = Comparison | SearchComparison | SearchGroup;

/**
 * A `db.query`/addon filter. Author it as a comparison (or several, ANDed) with
 * `expr(col("status"), "=", c.text("published"))` or, for the full operator set,
 * `cmp(col("tags"), "overlaps", inp("t"))`. Compose nested boolean logic with
 * `and(...)` / `or(...)`. A raw `Value` stays the escape hatch for a pre-built
 * clause. Encoded into the engine's operand-based `{expression:[…]}` search shape.
 */
export type DbWhere = Value | SearchNode | SearchNode[];

/**
 * Build a search comparison over the full operator set (`in`, `like`, `ilike`,
 * `between`, `contains`, `overlaps`, `@>`, `~`, `search`, …). Distinct from the
 * conditional `expr()`, which stays narrow. `opts.ignoreEmpty` skips the clause
 * when the resolved right value is empty.
 */
export function cmp(
  left: Value,
  op: SearchOp,
  right: Value,
  opts?: { ignoreEmpty?: boolean },
): SearchComparison {
  if (!SEARCH_OPS.has(op)) {
    throw new Error(
      `db search: unsupported operator "${op}". Supported: ${[...SEARCH_OPS].join(", ")}.`,
    );
  }
  return { left, op, right, ignoreEmpty: opts?.ignoreEmpty };
}

/** Group search nodes joined by AND (`and(a, b, or(c, d))`). */
export function and(...children: SearchNode[]): SearchGroup {
  return { or: false, children };
}

/** Group search nodes joined by OR (`or(a, b)`). */
export function or(...children: SearchNode[]): SearchGroup {
  return { or: true, children };
}

/** A tagged {@link Value} (`{value, tag, filters}`) — the raw-search escape hatch. */
function isValue(w: unknown): w is Value {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "tag" in w && "value" in w;
}

/** An and/or group node. */
function isGroup(w: unknown): w is SearchGroup {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "children" in w;
}

/** A comparison node (narrow `expr()` or full `cmp()`) — has `left` + `op`, not a tagged value. */
function isCmpNode(w: unknown): w is Comparison | SearchComparison {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "op" in w && "left" in w;
}

/** Encode a tagged value to the `{operand, tag, filters}` search operand shape. */
function toOperand(v: Value): { operand: string; tag: string; filters: unknown[] } {
  return { operand: v.value, tag: v.tag, filters: v.filters };
}

/** One `{type:"statement", or, group:{expression:[]}, statement:{op,left,right}}` node. */
function toStatementNode(node: Comparison | SearchComparison, or: boolean): unknown {
  const right: Record<string, unknown> = toOperand(node.right);
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
 * AND (`false`) for a flat `where`/`and(...)`, OR (`true`) for `or(...)`. The
 * first sibling never ORs to a nonexistent predecessor.
 */
function encodeContainer(children: SearchNode[], joinOr: boolean): unknown[] {
  return children.map((child, i) => {
    const or = joinOr && i > 0;
    if (isGroup(child)) {
      return { type: "group", or, group: { expression: encodeContainer(child.children, child.or) } };
    }
    return toStatementNode(child, or);
  });
}

/**
 * Encode `where` (+ an optional `additionalWhere`) into the single
 * `context.search` the engine reads (`mvp_search` = `{ expression: [...] }`).
 * Comparison clauses from both args concatenate into one `expression[]`, ANDed
 * (`or:false`) — the engine has exactly one `search`, so there is no separate
 * `additional_where`. A raw `Value` (escape hatch) passes through as
 * `context.search` directly, but cannot be combined with comparison clauses.
 */
export function encodeSearch(where?: DbWhere, additionalWhere?: DbWhere): unknown {
  const nodes: SearchNode[] = [];
  let raw: unknown;
  for (const w of [where, additionalWhere]) {
    if (!w) continue;
    if (Array.isArray(w)) nodes.push(...w);
    else if (isGroup(w) || isCmpNode(w)) nodes.push(w);
    else if (isValue(w)) raw = w;
    else {
      // Not comparison/group-shaped and not a tagged `Value` — a malformed `where`
      // (e.g. `op` mistyped as `operator`) would otherwise slip through as a
      // garbage `context.search`. Fail at the authoring site, not deep in the engine.
      throw new Error(
        "db search: `where` must be an expr(...)/cmp(...) comparison, an and()/or() group, an " +
          "array of those, or a tagged Value (inp/ref/col/c.*) — got an object that is neither. " +
          "Check for a typo (e.g. `operator` instead of `op`).",
      );
    }
  }
  if (raw !== undefined && nodes.length) {
    throw new Error(
      "db search: a raw Value `where` cannot be combined with expr()/cmp()/and()/or() clauses — " +
        "use one form or the other.",
    );
  }
  // Top-level siblings are ANDed (the engine has exactly one `search`, so
  // `where` + `additionalWhere` concatenate into one ANDed `expression[]`).
  if (nodes.length) return { expression: encodeContainer(nodes, false) };
  if (raw !== undefined) return raw;
  return undefined;
}

/** Encode sort directives to the `mvp_sort` element shape `{ sortBy, orderBy }`. */
export function encodeSort(sort?: SortDirective[]): Array<{ sortBy: string; orderBy: SortDir }> {
  return (sort ?? []).map((s) => ({ sortBy: s.sortBy, orderBy: s.dir ?? "asc" }));
}
