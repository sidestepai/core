/**
 * `s.workflow_test.call({ workflowTest, datasource?, as? })` — run a workflow test.
 *
 * Pass the DEF, not a bare name. A bare name is resolved to a guid with no
 * registry visibility, so a typo exports cleanly and then fails the import with
 * `Invalid <kind> reference. Try importing: <guid>`.
 *
 * `datasource` is left off on purpose. Omitted means an EMPTY datasource — the
 * recommended setting. Naming one makes the engine CLONE that datasource before
 * the test runs, which against production-sized data is slow enough to fail.
 */
import { defineFunction, s, ref } from "@sidestep/core";
import { doubleFnTest } from "../../kinds/workflowTest.js";

export const workflowTestCall = defineFunction({
  name: "ex_workflow_test_call",
  stack: [s.workflow_test.call({ workflowTest: doubleFnTest, as: "result" })],
  response: ref("result"),
});
