/**
 * `s.task.call({ task, as? })` — invoke a background task as a workspace run.
 *
 * Pass the DEF, not a bare name. A bare name is resolved to a guid with no
 * registry visibility, so a typo exports cleanly and then fails the import with
 * `Invalid <kind> reference. Try importing: <guid>`.
 */
import { defineFunction, s } from "@sidestep/core";
import { nightlyCleanup } from "../../kinds/task.js";

export const taskCall = defineFunction({
  name: "ex_task_call",
  stack: [s.task.call({ task: nightlyCleanup })],
});
