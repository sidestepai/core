/**
 * `s.realtime.get_session` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const realtimeGetSession = defineFunction({
  name: "ex_realtime_get_session",
  stack: [
    s.realtime.get_session({ as: "result" }),
  ],
  response: ref("result"),
});
