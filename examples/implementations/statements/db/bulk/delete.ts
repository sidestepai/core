/**
 * `s.db.bulk.delete` — delete many rows by a `where` search. Binds the deleted
 * count. NOTE: omitting `where` deletes EVERY row in the table.
 */
import { defineFunction, s, c, col, ref, expr } from "@sidestep/core";
import { posts } from "../../../_shared.js";

export const dbBulkDelete = defineFunction({
  name: "ex_db_bulk_delete",
  stack: [
    s.db.bulk.delete({ table: posts, where: expr(col("published"), "=", c.bool(false)), as: "deleted" }),
  ],
  response: ref("deleted"),
});
