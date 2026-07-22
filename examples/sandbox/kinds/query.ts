/**
 * `query({...})` — an HTTP API endpoint (payload key `query`), published under
 * an API group. This is the object kind; its `stack` uses the statement surface.
 */
import { query, s, inp, ref, input } from "@sidestep/core";
import { api, users } from "../_shared.js";

export const getUserQuery = query({
  name: "ex_get_user",
  verb: "GET",
  apiGroup: api,
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});
