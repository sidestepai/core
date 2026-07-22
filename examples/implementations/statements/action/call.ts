/**
 * `s.action.call({ action, input?, as? })` — invoke a marketplace action.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const actionCall = defineFunction({
  name: "ex_action_call",
  stack: [s.action.call({ action: "ex_send_email", input: { to: c.text("a@example.com") }, as: "sent" })],
  response: ref("sent"),
});
