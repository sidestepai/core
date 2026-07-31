/**
 * `s.db.add` — insert a record. Binds the full inserted row (with `id`/`created_at`).
 *
 * PARAM GATE: the row payload. Use the ergonomic `row: {...}` partial (expanded
 * against the table's columns) or the explicit `data: [{ name, value }]` entries
 * for byte-exact control over each field.
 */
import { defineFunction, s, c, inp, ref, input } from "@sidestep/core";
import { users } from "../../_shared.js";

/** Gate 1 — ergonomic `row` (expanded against the table schema). */
export const dbAddRow = defineFunction({
  name: "ex_db_add_row",
  input: { email: input.email({ required: true }), name: input.text() },
  stack: [
    s.db.add({ table: users, row: { email: inp("email"), name: inp("name") }, as: "created" }),
  ],
  response: ref("created"),
});

/**
 * Gate 3 — `output` restricts the columns of the RETURNED row. It does NOT
 * change what is written: every column in `row` is still inserted, the response
 * just carries the listed ones. `InferRow` narrows to match, so `created` here
 * is typed `{ id, email }` and reading `created.name` is a compile error.
 *
 * This is the surface for not handing a caller back columns it should not see
 * (a password hash, an internal flag) on the write that created them.
 * The same `output` is available on `s.db.edit` and `s.db.patch`.
 */
export const dbAddOutput = defineFunction({
  name: "ex_db_add_output",
  input: { email: input.email({ required: true }), name: input.text() },
  stack: [
    s.db.add({
      table: users,
      row: { email: inp("email"), name: inp("name") },
      output: ["id", "email"],
      as: "created",
    }),
  ],
  response: ref("created"),
});

/** Gate 2 — explicit `data` entries (full control over each field + `ignore`). */
export const dbAddData = defineFunction({
  name: "ex_db_add_data",
  stack: [
    s.db.add({
      table: users,
      data: [
        { name: "email", value: c.text("new@example.com") },
        { name: "votes", value: c.int(0) },
      ],
      as: "created",
    }),
  ],
  response: ref("created"),
});
