/**
 * `s.task.call({ task, as? })` — invoke a background task as a workspace run.
 */
import { defineFunction, s } from "@sidestep/core";

export const taskCall = defineFunction({
  name: "ex_task_call",
  stack: [s.task.call({ task: "ex_nightly_cleanup" })],
});
