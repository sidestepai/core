/**
 * `s.db.bulk.update` — replace many rows (each item carries its key).
 */
import { defineFunction, s, c } from "@sidestep/core";
import { users } from "../../../_shared.js";

export const dbBulkUpdate = defineFunction({
  name: "ex_db_bulk_update",
  stack: [
    s.db.bulk.update({
      table: users,
      items: c.array([{ id: 1, email: "a@example.com", votes: 5 }]),
    }),
  ],
});
