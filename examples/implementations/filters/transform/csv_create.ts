/**
 * `fl.csv_create` filter (group: transform).
 * Creates a CSV format data stream from a list of column names and their corresponding data rows.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCsvCreate = defineFunction({
  name: "ex_filter_csv_create",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["csv_create"](c.array([1, 2]))))],
  response: ref("out"),
});
