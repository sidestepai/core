/**
 * `s.db.get` — fetch a single record by a field match (defaults to `id`).
 *
 * PARAM GATE: the lookup field. Omit `fieldName` to match the primary key `id`,
 * or name a column to match on it. `output` narrows the returned columns.
 */
import { defineFunction, s, inp, ref, input } from "@sidestep/core";
import { users } from "../../_shared.js";

/** Gate 1 — lookup by primary key (`fieldName` omitted → `id`). */
export const dbGetById = defineFunction({
  name: "ex_db_get_by_id",
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});

/** Gate 2 — lookup by a named column, with a narrowed `output` column set. */
export const dbGetByEmail = defineFunction({
  name: "ex_db_get_by_email",
  input: { email: input.email({ required: true }) },
  stack: [
    s.db.get({
      table: users,
      fieldName: "email",
      fieldValue: inp("email"),
      output: ["id", "email", "name"],
      as: "user",
    }),
  ],
  response: ref("user"),
});
