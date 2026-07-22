/**
 * `f.date` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 */
import { table, f } from "@sidestep/core";

export const fieldDate = table({
  name: "ex_field_date",
  schema: {
    primary: f.date(),
  },
});
