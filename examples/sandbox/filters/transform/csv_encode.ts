/**
 * `fl.csv_encode` filter (group: transform).
 * Encodes the value and returns the result in CSV format
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCsvEncode = defineFunction({
  name: "ex_filter_csv_encode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["csv_encode"]()))],
  response: ref("out"),
});
