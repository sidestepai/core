/**
 * `s.trigger.call({ trigger, input?, as? })` — invoke a trigger as a workspace run.
 */
import { defineFunction, s, c } from "@sidestep/core";

export const triggerCall = defineFunction({
  name: "ex_trigger_call",
  stack: [s.trigger.call({ trigger: "ex_on_user_insert", input: { new: c.obj({ id: 1 }) } })],
});
