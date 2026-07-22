/**
 * `s.stream.from_request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const streamFromRequest = defineFunction({
  name: "ex_stream_from_request",
  stack: [
    s.stream.from_request({ as: "result" }),
  ],
  response: ref("result"),
});
