/**
 * `s.array.map({ source, transform?, as? })` — map each element through an
 * expression. `$this` is the current element.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const arrayMap = defineFunction({
  name: "ex_array_map",
  stack: [
    s.array.map({
      source: c.array([1, 2, 3]),
      transform: withFilters(ref("$this"), fl.mul(c.int(2))),
      as: "doubled",
    }),
  ],
  response: ref("doubled"),
});
