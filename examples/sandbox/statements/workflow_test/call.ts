/**
 * `s.workflow_test.call({ workflowTest, datasource?, as? })` — run a workflow test.
 */
import { defineFunction, s, ref } from "@sidestep/core";

export const workflowTestCall = defineFunction({
  name: "ex_workflow_test_call",
  stack: [s.workflow_test.call({ workflowTest: "ex_signup_test", datasource: "test", as: "result" })],
  response: ref("result"),
});
