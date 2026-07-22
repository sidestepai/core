/**
 * `task({...})` — a scheduled/background job (payload key `task`). Function-like
 * `stack` plus a `schedule`.
 */
import { task, s, c, col, expr } from "@sidestep/core";
import { posts } from "../_shared.js";

export const nightlyCleanup = task({
  name: "ex_kind_nightly_cleanup",
  // Run daily (freq in seconds) starting at a fixed timestamp.
  schedule: [{ startsOn: "2026-01-01T00:00:00Z", freq: 86400, repeatEnabled: true }],
  stack: [s.db.bulk.delete({ table: posts, where: expr(col("published"), "=", c.bool(false)) })],
});
