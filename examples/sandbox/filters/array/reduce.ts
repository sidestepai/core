/**
 * `fl.reduce` filter (group: array).
 * Reduces the array to a single value using the code block to combine each element of the array.
 *
 * Two things this example exists to say (issue #221). The accumulator is
 * `$result` — `lam.fn` makes it a parameter, so autocomplete offers it and
 * `$acc` does not compile. And `initial_value` is REQUIRED: it sits in front of
 * `code`, so omitting it would put the body in the initial-value slot.
 */
import { defineFunction, s, c, ref, withFilters, fl, lam } from "@sidestep/core";

export const filterReduce = defineFunction({
  name: "ex_filter_reduce",
  stack: [
    s.set_var(
      "out",
      withFilters(
        c.array([1, 2, 3, 4]),
        // [1,2,3,4] sums to 10.
        fl.reduce({ initial_value: 0, code: lam.fn(({ $result, $this }) => $result + $this) }),
      ),
    ),
  ],
  response: ref("out"),
});
