/**
 * `f.tableRef(table, opts?)` — a foreign-key column that links to another
 * table's primary key. (Not `ref` — that is a stack-variable value reference.)
 */
import { table, f } from "@sidestep/core";
import { users } from "../_shared.js";

export const fieldTableRef = table({
  name: "ex_field_table_ref",
  schema: {
    owner_id: f.tableRef(users, { required: true }),
  },
});
