/**
 * Shared db-search authoring primitives — the `where`/`sort` surface used by
 * both `s.db.query` (`./db.ts`) and a table-bound `addon()`
 * (`../../kinds/addon.ts`). Extracted here so the addon kind can reuse the exact
 * same builders without importing `db.ts` (which imports the addon kind — a
 * cycle).
 *
 * The boolean-expression algebra (`cmp`/`and`/`or`, the node types, the tree
 * walk) now lives in {@link ../expression.js}; this module keeps the db-specific
 * pieces — `where`/`additionalWhere` merge, sort, eval — and supplies the
 * filter-rejecting operand encoder (#118) to the shared walk.
 */
import type { Value } from "../../values/value.js";
import type { Prettify } from "../../fields/value-types.js";
import type { QualifiedCol } from "./output-select.js";
import {
  type SearchNode,
  isValue,
  isGroup,
  isMixed,
  isCmpNode,
  encodeExpression,
} from "../expression.js";

// Re-export the shared algebra so existing `db-search.js` importers (incl. the
// public `index.ts` surface) keep resolving from here.
export { cmp, and, or, mixed } from "../expression.js";
export type {
  SearchOp,
  SearchComparison,
  SearchGroup,
  SearchNode,
  MixedGroup,
  MixedTerm,
} from "../expression.js";

/** Sort direction for a {@link SortDirective} — the engine's `orderBy` values. */
export type SortDir = "asc" | "desc" | "rand";

/**
 * One sort directive: order the returned rows by `sortBy`, ascending, descending,
 * or random. `dir` maps to the engine's `orderBy`; the encoded element is the
 * `mvp_sort` shape `{ sortBy, orderBy }`. Each caller places that element
 * differently — `db.query` under `context.return.list.sort` (via
 * the engine's context-to-config conversion), an `addon()` at top-level `context.sort` — so
 * this doc stays placement-neutral; see each caller's own doc for where it lands.
 */
export interface SortDirective<C extends string = string> {
  /**
   * The column to sort by, or a dotted path qualifying one — a joined table's
   * column (its `bind` alias), or the bound table's own `tableAlias`
   * (`"comments.id"`), which is the form Xano's editor writes. A column of the
   * bound table is BARE unless the query sets `tableAlias`; see
   * {@link QualifiedCol}.
   */
  sortBy: QualifiedCol<C>;
  /** Direction (`"asc"` | `"desc"` | `"rand"`); defaults to ascending. */
  dir?: SortDir;
}

/**
 * A `db.query`/addon filter. Author it as a comparison (or several, ANDed) with
 * `expr(col("status"), "=", c.text("published"))` or, for the full operator set,
 * `cmp(col("tags"), "overlaps", inp("t"))`. Compose nested boolean logic with
 * `and(...)` / `or(...)`. A raw `Value` stays the escape hatch for a pre-built
 * clause. Encoded into the engine's operand-based `{expression:[…]}` search shape.
 */
export type DbWhere = Value | SearchNode | SearchNode[];

/**
 * Encode `where` (+ an optional `additionalWhere`) into the single
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
    else if (isGroup(w) || isMixed(w) || isCmpNode(w)) nodes.push(w);
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
  // Routed through `encodeExpression` rather than `encodeContainer` so a lone
  // root `or(...)` splices its children flat here exactly as it does in a
  // conditional — the two must not disagree about what `or(...)` means.
  if (nodes.length) return encodeExpression(nodes);
  if (raw !== undefined) return raw;
  return undefined;
}

/** Encode sort directives to the `mvp_sort` element shape `{ sortBy, orderBy }`. */
export function encodeSort(sort?: SortDirective[]): Array<{ sortBy: string; orderBy: SortDir }> {
  return (sort ?? []).map((s) => ({ sortBy: s.sortBy, orderBy: s.dir ?? "asc" }));
}

// ---------------------------------------------------------------------------
// Eval / computed-column primitives — shared by `s.db.query` (`context.eval[]`,
// aggregate `group`/`eval`) and `addon()` (same). Lives here (not db.ts) so the
// addon kind can reuse it without importing db.ts (a cycle).
// ---------------------------------------------------------------------------

/** One step of an eval filter pipeline (`{ name, arg, disabled? }`) — engine `mvp_filter`. */
export interface DbEvalFilter {
  name: string;
  /** Filter args as tagged values (encoded `{value,tag,filters}`). */
  arg?: Value[];
  /** Skip this step (kept in the stored pipeline as `disabled:true`). */
  disabled?: boolean;
}

/**
 * A computed output column (`context.eval[]`): source column/path `name`, output
 * alias `as`, and an optional `filters` pipeline. The `as` grafts onto the
 * returned row as an `unknown`-typed key. Also used for aggregate `group`/`eval`.
 */
export interface DbEval {
  /** Source column or dotted path (e.g. `"book.name"`). */
  name: string;
  /** Output alias — the row key this eval lands under. */
  as: string;
  /** Optional filter pipeline applied to the value. */
  filters?: DbEvalFilter[];
}

/**
 * Encode `context.eval[]` — one `{ as, name, filters }` per computed column. Each
 * filter step is `{ name, arg, disabled? }` with `arg` a list of tagged values;
 * `disabled` is dropped at its default. Byte shape from the `list-evals` golden.
 */
export function encodeEval(evals?: readonly DbEval[]): unknown[] | undefined {
  if (!evals?.length) return undefined;
  return evals.map((e) => ({
    as: e.as,
    name: e.name,
    filters: (e.filters ?? []).map((f) => ({
      name: f.name,
      arg: (f.arg ?? []).map((v) => ({ value: v.value, tag: v.tag, filters: v.filters })),
      ...(f.disabled ? { disabled: true } : {}),
    })),
  }));
}

/**
 * Alias-qualify aggregate `group`/`eval` column names. The engine rejects a bare
 * (dotless) column in an aggregate with `Unsupported param format - <col>`; a name
 * must be `<tableAlias>.<column>`. A bare author name is prefixed with the query's
 * primary table alias (`primaryAlias`, the table name — the default `dbo.as`); a
 * name the author already dotted (a `bind`ed/joined column) passes through. The
 * result is guarded to a real `<alias>.<col>` shape so an unresolvable name fails
 * at export instead of 500ing at runtime. Used by both `db.query` aggregate and
 * the `cardinality:"aggregate"` addon.
 */
export function qualifyAggregateEvals(
  evals: readonly DbEval[] | undefined,
  primaryAlias: string,
  kind: "group" | "eval",
): DbEval[] | undefined {
  if (!evals?.length) return evals as DbEval[] | undefined;
  return evals.map((e) => {
    const name = e.name.includes(".") ? e.name : `${primaryAlias}.${e.name}`;
    // Emulates the engine's own check: the qualified name must be a real
    // `<alias>.<column>` (non-empty on both sides of the dot). Trips when the
    // primary alias is unresolvable or the author's dotted name is malformed.
    if (!/^[^.]+\.[^.].*$/.test(name)) {
      throw new Error(
        `aggregate ${kind}: name "${e.name}" must be an alias-qualified column ` +
          `(e.g. "${primaryAlias || "<table>"}.${e.name}") — the engine rejects a bare ` +
          `column name in an aggregate. Qualify it with the table alias, or the bind ` +
          `alias for a joined column.`,
      );
    }
    return { ...e, name };
  });
}

/**
 * The keys a set of `eval` (or aggregate `group`/`eval`) columns graft onto a
 * row. Each entry's `as` alias becomes a key valued `unknown` — a filter
 * pipeline's output isn't statically knowable. An absent set contributes none.
 */
export type EvalFields<E> = E extends readonly [infer H, ...infer Rest]
  ? (H extends { as: infer S extends string } ? { [K in S]: unknown } : object) & EvalFields<Rest>
  : object;

/**
 * The row an aggregate query/addon yields — keyed by every `group` and `eval`
 * alias (values `unknown`). Reuses {@link EvalFields}; absent group/eval → no keys.
 */
export type AggregateRow<AG> = AG extends { group?: infer G; eval?: infer EV }
  ? Prettify<EvalFields<G> & EvalFields<EV>>
  : Record<string, unknown>;
