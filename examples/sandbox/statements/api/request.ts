/**
 * `s.api.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const apiRequest = defineFunction({
  name: "ex_api_request",
  stack: [
    s.api.request({ as: "result" }),
  ],
  response: ref("result"),
});
