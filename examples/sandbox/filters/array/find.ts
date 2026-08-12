/**
 * `fl.find` filter (group: array).
 * Returns the first element the body accepts.
 *
 * `$index` is bound alongside `$this`, so a positional test is available too.
 */
import { defineFunction, s, c, ref, withFilters, fl, lam } from "@sidestep/core";

export const filterFind = defineFunction({
  name: "ex_filter_find",
  stack: [
    s.set_var(
      "out",
      // 3 — the first element over 2.
      withFilters(c.array([1, 2, 3, 4]), fl.find(lam.fn(({ $this }) => $this > 2, { surface: "find" }))),
    ),
  ],
  response: ref("out"),
});
