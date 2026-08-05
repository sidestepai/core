/**
 * `workflowTest({...})` — an end-to-end test (payload key `workflow_test`).
 *
 * A workflow test takes NO input and returns NO response. It runs other
 * workspace objects and asserts on what they bind, so the shape is always the
 * same: a `.call` that binds with `as`, then `s.expect.*` against that variable.
 *
 * `datasource` is left off on purpose. Omitted means an EMPTY datasource — the
 * recommended setting. Naming one makes the engine CLONE that datasource before
 * every run, which against production-sized data is slow enough to fail the run.
 */
import { workflowTest, s, c, ref } from "@sidestep/core";
import { doubleFn } from "../_shared.js";

export const doubleFnTest = workflowTest({
  name: "ex_kind_double_fn_test",
  description: "ex_shared_double returns its input doubled",
  tags: ["smoke"],
  stack: [
    s.function.call({ fn: doubleFn, input: { n: 21 }, as: "doubled" }),
    s.expect.to_be_defined({ expr: ref("doubled") }),
    s.expect.to_equal({ expr: ref("doubled"), value: c.int(42) }),
  ],
});
