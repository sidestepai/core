/**
 * `cmp(left, op, right)` + `and(...)` / `or(...)` — the search-comparison
 * builders for a `db.query` `where`. `cmp` supports the richer engine operators
 * (e.g. "like", "in") beyond `expr`'s six.
 */
import { defineFunction, s, c, col, ref, cmp, and, or } from "@sidestep/core";
import { posts } from "../_shared.js";

export const valueCmp = defineFunction({
  name: "ex_value_cmp",
  stack: [
    s.db.query({
      table: posts,
      where: and(
        cmp(col("published"), "=", c.bool(true)),
        or(cmp(col("score"), ">", c.int(10)), cmp(col("title"), "like", c.text("%xano%"))),
      ),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
