/**
 * `c.now()` — current time as epoch-milliseconds (the `text("now") |to_epoch_ms`
 * chain). It's a **filtered** value, so it can't be an inline `where`/`cmp`
 * operand (export rejects that, issue #118) — hoist it into a stack var first,
 * do the cutoff math there, then compare against the var. This models the
 * SLA/expiry pattern: "rows older than an hour".
 */
import { defineFunction, s, c, col, cmp, ref, fl, withFilters } from "@sidestep/core";
import { posts } from "../../_shared.js";

const ONE_HOUR_MS = 3_600_000;

export const constNow = defineFunction({
  name: "ex_value_const_now",
  stack: [
    // Hoist `now - 1h` into a var (the required step — not inline in the where).
    s.set_var("cutoff", withFilters(c.now(), fl.epochms_add_ms(c.int(-ONE_HOUR_MS)))),
    s.db.query({
      table: posts,
      where: cmp(col("created_at"), "<", ref("cutoff")),
      as: "stale",
    }),
  ],
  response: ref("stale"),
});
