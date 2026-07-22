/**
 * `f.decimal` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 */
import { table, f } from "@sidestep/core";

export const fieldDecimal = table({
  name: "ex_field_decimal",
  schema: {
    primary: f.decimal({ default: "0" }),
    rate: f.decimal(),
  },
});
