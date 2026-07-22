/**
 * `s.api.call({ api, input?, headers?, auth?, as? })` — invoke an API endpoint
 * as a workspace run.
 *
 * PARAM GATE: `auth` authenticates the call with a token.
 */
import { defineFunction, s, c, inp, ref, input } from "@sidestep/core";

/** Gate 1 — plain call. */
export const apiCall = defineFunction({
  name: "ex_api_call",
  stack: [s.api.call({ api: "ex_get_user", input: { id: c.int(1) }, as: "res" })],
  response: ref("res"),
});

/** Gate 2 — authenticated call with a bearer token. */
export const apiCallAuthed = defineFunction({
  name: "ex_api_call_authed",
  input: { token: input.text({ required: true }) },
  stack: [
    s.api.call({ api: "ex_get_user", input: { id: c.int(1) }, auth: { token: inp("token") }, as: "res" }),
  ],
  response: ref("res"),
});
