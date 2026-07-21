/**
 * Shared db-search authoring primitives — the `where`/`sort` surface used by
 * both `s.db.query` (`./db.ts`) and a table-bound `addon()`
 * (`../../kinds/addon.ts`). Extracted here so the addon kind can reuse the exact
 * same builders without importing `db.ts` (which imports the addon kind — a
 * cycle).
 */
import type { Value } from "../../values/value.js";
import { encodeSearchExpression } from "../conditional.js";
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
 * A `db.query`/addon filter. Author it as a comparison (or several, ANDed) with
 * `expr(col("status"), "=", c.text("published"))` — encoded into the engine's
 * operand-based `{expression:[…]}` search shape (the same algebra as a
 * conditional `when` / a table trigger's search). A raw `Value` stays the escape
 * hatch for a pre-built clause.
 */
export type DbWhere = Value | Comparison | Comparison[];

/** A `Comparison` (`{left, op, right}`) vs a tagged `Value` (`{value, tag, filters}`). */
function isComparison(w: DbWhere): w is Comparison {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "op" in w && "left" in w;
}

/** A tagged {@link Value} (`{value, tag, filters}`) — the raw-search escape hatch. */
function isValue(w: unknown): w is Value {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "tag" in w && "value" in w;
}

/** Normalize a `DbWhere` to `Comparison[]`, or `null` for the raw-`Value` escape hatch. */
function toComparisons(w: DbWhere): Comparison[] | null {
  if (Array.isArray(w)) return w;
  if (isComparison(w)) return [w];
  return null;
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
  const clauses: Comparison[] = [];
  let raw: unknown;
  for (const w of [where, additionalWhere]) {
    if (!w) continue;
    const cmps = toComparisons(w);
    if (cmps) clauses.push(...cmps);
    else if (isValue(w)) raw = w;
    else {
      // Not comparison-shaped and not a tagged `Value` — a malformed `where`
      // (e.g. `op` mistyped as `operator`) would otherwise slip through as a
      // garbage `context.search`. Fail at the authoring site, not deep in the engine.
      throw new Error(
        "db search: `where` must be an expr(...) comparison, an array of comparisons, or a " +
          "tagged Value (inp/ref/col/c.*) — got an object that is neither. Check for a typo " +
          "(e.g. `operator` instead of `op`).",
      );
    }
  }
  if (raw !== undefined && clauses.length) {
    throw new Error(
      "db search: a raw Value `where` cannot be combined with `expr(...)` clauses — " +
        "use one form or the other.",
    );
  }
  if (clauses.length) return encodeSearchExpression(clauses);
  if (raw !== undefined) return raw;
  return undefined;
}

/** Encode sort directives to the `mvp_sort` element shape `{ sortBy, orderBy }`. */
export function encodeSort(sort?: SortDirective[]): Array<{ sortBy: string; orderBy: SortDir }> {
  return (sort ?? []).map((s) => ({ sortBy: s.sortBy, orderBy: s.dir ?? "asc" }));
}
