/**
 * `fl.digitOk` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterDigitOk = defineFunction({
  name: "ex_filter_digitOk",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["digitOk"]()))],
  response: ref("out"),
});
