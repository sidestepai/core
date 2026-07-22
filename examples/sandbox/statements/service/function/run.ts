/**
 * `s.service.function.run({ fn, input?, runtimeMode?, as? })` — run a
 * connected-service function.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";
import { doubleFn } from "../../../_shared.js";

export const serviceFunctionRun = defineFunction({
  name: "ex_service_function_run",
  stack: [s.service.function.run({ fn: doubleFn, input: { n: c.int(3) }, as: "out" })],
  response: ref("out"),
});
