/**
 * `s.function.run({ fn, input?, as? })` — run another function inline.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";
import { doubleFn } from "../../_shared.js";

export const functionRun = defineFunction({
  name: "ex_function_run",
  stack: [s.function.run({ fn: doubleFn, input: { n: c.int(21) }, as: "doubled" })],
  response: ref("doubled"),
});
