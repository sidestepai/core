/**
 * `s.api.lambda` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const apiLambda = defineFunction({
  name: "ex_api_lambda",
  stack: [
    s.api.lambda({ as: "result" }),
  ],
  response: ref("result"),
});
