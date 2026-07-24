/**
 * #118 re-verification probe (NOT a shipped example, NOT auto-indexed).
 *
 * Does a db.query `where` accept an inline FILTERED operand, or does it still 500
 * (#118)? The SDK rejects filtered search operands at export, so this probe is
 * only deployable with the db-search guard temporarily relaxed to pass-through.
 *
 * Run (with the guard temporarily relaxed):
 *   node dist/bin.js validate examples/sandbox/_capture-search.ts --runtime --out validate-out
 */
import { workspace, defineFunction, s, c, col, ref, expr, withFilters, filter } from "@sidestep/core";
import { users, posts } from "./_shared.js";

const defs = (xs: unknown[]) => xs as never[];

/** Left operand filtered, no-arg filter. */
const probeSearchLeft = defineFunction({
  name: "ex_probe_search_left",
  stack: [
    s.db.query({
      table: posts,
      where: expr(withFilters(col("title"), filter("trim")), "=", c.text("hello")),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/** Right operand filtered. */
const probeSearchRight = defineFunction({
  name: "ex_probe_search_right",
  stack: [
    s.db.query({
      table: posts,
      where: expr(col("title"), "=", withFilters(c.text("HELLO"), filter("to_lower"))),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/** Filter WITH an argument (the #118 error was about filter-arg resolution). */
const probeSearchFilterArg = defineFunction({
  name: "ex_probe_search_filter_arg",
  stack: [
    s.db.query({
      table: posts,
      where: expr(withFilters(col("title"), filter("first", c.int(3))), "=", c.text("hel")),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

export default workspace("sidestep-capture-search")
  .registerTables(defs([users, posts]))
  .registerFunctions(defs([probeSearchLeft, probeSearchRight, probeSearchFilterArg]));
