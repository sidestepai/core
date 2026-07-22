/**
 * `s.db.query` — the full "Query All Records" surface. Only `db.query` takes a
 * `where` comparison (built with `expr`/`cmp`/`and`/`or` over `col(...)`),
 * `sort`, and `paging`.
 *
 * PARAM GATE: the return shape + query controls.
 */
import { defineFunction, s, c, col, inp, ref, expr, and, input } from "@sidestep/core";
import { posts } from "../../_shared.js";

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
