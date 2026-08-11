/**
 * `s.db.query` — the full "Query All Records" surface. Only `db.query` takes a
 * `where` comparison (built with `expr`/`cmp`/`and`/`or` over `col(...)`),
 * `sort`, and `paging`.
 *
 * PARAM GATE: the return shape + query controls.
 */
import { defineFunction, s, c, col, inp, ref, expr, and, input } from "@sidestep/core";
import { posts, users } from "../../_shared.js";

/** Gate 1 — a simple filtered list (`where` only). */
export const dbQueryWhere = defineFunction({
  name: "ex_db_query_where",
  stack: [
    s.db.query({
      table: posts,
      where: expr(col("published"), "=", c.bool(true)),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/** Gate 2 — filter + sort + paging (metadata envelope). */
export const dbQueryPaged = defineFunction({
  name: "ex_db_query_paged",
  input: { page: input.int() },
  stack: [
    s.db.query({
      table: posts,
      where: and(expr(col("published"), "=", c.bool(true)), expr(col("score"), ">", c.int(0))),
      sort: [{ sortBy: "score", dir: "desc" }],
      paging: { page: inp("page"), per_page: 10 },
      as: "page",
    }),
  ],
  response: ref("page"),
});

/** Gate 3 — a count (`returnType: "count"` binds a number). */
export const dbQueryCount = defineFunction({
  name: "ex_db_query_count",
  stack: [
    s.db.query({
      table: posts,
      returnType: "count",
      where: expr(col("published"), "=", c.bool(true)),
      as: "total",
    }),
  ],
  response: ref("total"),
});

/**
 * Gate 4 — aggregate / group-by (`returnType: "aggregate"`). Roll rows up by a
 * `group` column with `eval` aggregators (`count`/`sum`/… ride `filters`). Write
 * `name` as a bare column — it is alias-qualified to `"posts.<col>"` on emit (the
 * engine requires the qualified form for aggregate columns) and the statement
 * declares `posts` as its alias so that qualified name resolves (#213).
 * Byte-verified against a live capture (#133).
 */
export const dbQueryAggregate = defineFunction({
  name: "ex_db_query_aggregate",
  stack: [
    s.db.query({
      table: posts,
      returnType: "aggregate",
      aggregate: {
        group: [{ name: "published", as: "published" }],
        eval: [
          { name: "id", as: "count", filters: [{ name: "count" }] },
          { name: "score", as: "total", filters: [{ name: "sum" }] },
        ],
      },
      as: "rollup",
    }),
  ],
  response: ref("rollup"),
});

/**
 * Gate 5 — a JOIN (`bind`), and the one thing to get right about it (#213).
 *
 * The two sides of a join condition are spelled DIFFERENTLY:
 *   - the JOINED table's column takes its `as` alias — `col("author.id")`
 *   - this query's OWN column stays BARE — `col("author_id")`
 *
 * Qualifying your own column with the table's name (`col("posts.author_id")`)
 * resolves only if the query also sets `tableAlias` (see Gate 6). `db.query`
 * rejects the unresolvable spelling at export rather than letting it 400 at
 * runtime with an error naming the wrong operand.
 *
 * A join widens what `where`/`sort`/`eval` can address; it does not by itself
 * add the joined columns to the row — `eval` grafts the ones you want.
 */
export const dbQueryJoin = defineFunction({
  name: "ex_db_query_join",
  stack: [
    s.db.query({
      table: posts,
      bind: [{ table: users, as: "author", join: "left", where: expr(col("author_id"), "=", col("author.id")) }],
      eval: [{ name: "author.name", as: "author_name" }],
      sort: [{ sortBy: "author.name", dir: "asc" }],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * Gate 6 — the same join with `tableAlias`, which is what lets BOTH sides be
 * dotted. `tableAlias` is the SQL alias for this query's own table
 * (`context.dbo.as`); once it is declared, `col("p.author_id")` resolves the way
 * `col("author.id")` does. Useful when a condition reads better fully qualified,
 * or when two joins make the bare form ambiguous to a reader.
 */
export const dbQueryJoinAliased = defineFunction({
  name: "ex_db_query_join_aliased",
  stack: [
    s.db.query({
      table: posts,
      tableAlias: "p",
      bind: [{ table: users, as: "author", join: "left", where: expr(col("p.author_id"), "=", col("author.id")) }],
      where: expr(col("p.published"), "=", c.bool(true)),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
