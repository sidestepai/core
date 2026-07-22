/**
 * `s.db.bulk.add` — insert many rows at once.
 *
 * PARAM GATE: `allowIdField` permits explicit `id` values in the rows.
 */
import { defineFunction, s, c } from "@sidestep/core";
import { users } from "../../../_shared.js";

export const dbBulkAdd = defineFunction({
  name: "ex_db_bulk_add",
  stack: [
    s.db.bulk.add({
      table: users,
      items: c.array([{ email: "a@example.com" }, { email: "b@example.com" }]),
    }),
  ],
});
