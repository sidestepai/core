/**
 * `s.db.external.mssql.direct_query` — run raw SQL against an external
 * mssql database over a connection string. Binds the result list.
 */
import { defineFunction, s, c, inp, ref, input } from "@sidestep/core";

export const dbExternalMssqlDirectQuery = defineFunction({
  name: "ex_db_external_mssql_direct_query",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.external.mssql.direct_query({
      sql: "SELECT * FROM accounts WHERE id = ?",
      connectionString: c.text("connection-string-here"),
      args: [inp("id")],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
