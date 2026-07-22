/**
 * `s.db.external.snowflake.direct_query` — run raw SQL against an external
 * snowflake database over a connection string. Binds the result list.
 */
import { defineFunction, s, c, inp, ref, input } from "@sidestep/core";

export const dbExternalSnowflakeDirectQuery = defineFunction({
  name: "ex_db_external_snowflake_direct_query",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.external.snowflake.direct_query({
      sql: "SELECT * FROM accounts WHERE id = ?",
      connectionString: c.text("connection-string-here"),
      args: [inp("id")],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
