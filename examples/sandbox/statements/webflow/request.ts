/**
 * `s.webflow.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const webflowRequest = defineFunction({
  name: "ex_webflow_request",
  stack: [
    s.webflow.request({ as: "result" }),
  ],
  response: ref("result"),
});
