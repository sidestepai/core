/**
 * `s.function.call({ fn, input?, as? })` — invoke a function as a workspace run.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";
import { doubleFn } from "../../_shared.js";

export const functionCall = defineFunction({
  name: "ex_function_call",
  stack: [s.function.call({ fn: doubleFn, input: { n: c.int(5) }, as: "out" })],
  response: ref("out"),
});
