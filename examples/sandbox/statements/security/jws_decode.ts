/**
 * `s.security.jws_decode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityJwsDecode = defineFunction({
  name: "ex_security_jws_decode",
  stack: [
    s.security.jws_decode({ as: "result" }),
  ],
  response: ref("result"),
});
