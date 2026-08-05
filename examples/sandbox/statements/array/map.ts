/**
 * `s.array.map({ source, transform?, as? })` — map each element through an
 * expression. `$this` is the current element, `$index` its position.
 *
 * `transform` picks the output shape: a single value maps each item to that
 * value; a record of values maps each item to an object with those keys.
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

/** The object form: `[1,2,3]` → `[{value:1, position:0}, …]`. */
export const arrayMapToObjects = defineFunction({
  name: "ex_array_map_object",
  stack: [
    s.array.map({
      source: c.array([1, 2, 3]),
      transform: { value: ref("$this"), position: ref("$index") },
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
