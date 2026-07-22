/**
 * `s.db.edit` — update a record matched by a field. A partial `row` writes ONLY
 * the columns you list; unmentioned columns keep their stored value (issue #33).
 * Binds the full post-mutation row.
 */
import { defineFunction, s, inp, ref, input } from "@sidestep/core";
import { users } from "../../_shared.js";

/** Bump `votes` alone, leaving every other column intact. */
export const dbEdit = defineFunction({
  name: "ex_db_edit",
  input: { id: input.int({ required: true }), votes: input.int({ required: true }) },
  stack: [
    s.db.edit({ table: users, fieldValue: inp("id"), row: { votes: inp("votes") }, as: "updated" }),
  ],
  response: ref("updated"),
});
