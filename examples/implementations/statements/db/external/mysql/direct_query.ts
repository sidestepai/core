/**
 * `s.db.external.mysql.direct_query` — run raw SQL against an external
 * mysql database over a connection string. Binds the result list.
 */
import { defineFunction, s, c, inp, ref, input } from "@sidestep/core";

export const dbExternalMysqlDirectQuery = defineFunction({
  name: "ex_db_external_mysql_direct_query",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.external.mysql.direct_query({
      sql: "SELECT * FROM accounts WHERE id = ?",
      connectionString: c.text("connection-string-here"),
      args: [inp("id")],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
