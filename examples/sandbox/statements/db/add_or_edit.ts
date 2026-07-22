/**
 * `s.db.add_or_edit` — upsert: edit the matched row if it exists, else insert.
 * Binds the full upserted row.
 */
import { defineFunction, s, inp, ref, input } from "@sidestep/core";
import { users } from "../../_shared.js";

export const dbAddOrEdit = defineFunction({
  name: "ex_db_add_or_edit",
  input: { email: input.email({ required: true }), name: input.text() },
  stack: [
    s.db.add_or_edit({
      table: users,
      fieldName: "email",
      fieldValue: inp("email"),
      row: { email: inp("email"), name: inp("name") },
      as: "upserted",
    }),
  ],
  response: ref("upserted"),
});
