/**
 * `f.int` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 */
import { table, f } from "@sidestep/core";

export const fieldInt = table({
  name: "ex_field_int",
  schema: {
    primary: f.int({ default: "0" }),
    quantity: f.int({ array: true }),
  },
});
