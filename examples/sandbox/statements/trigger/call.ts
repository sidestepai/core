/**
 * `s.trigger.call({ trigger, input?, as? })` — invoke a trigger as a workspace run.
 *
 * Pass the DEF, not a bare name. A bare name is resolved to a guid with no
 * registry visibility, so a typo exports cleanly and then fails the import with
 * `Invalid <kind> reference. Try importing: <guid>`.
 */
import { defineFunction, s, c } from "@sidestep/core";
import { onUserInsert } from "../../kinds/trigger.js";

export const triggerCall = defineFunction({
  name: "ex_trigger_call",
  stack: [s.trigger.call({ trigger: onUserInsert, input: { new: c.obj({ id: 1 }) } })],
});
