/**
 * `s.security.jwe_encode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityJweEncode = defineFunction({
  name: "ex_security_jwe_encode",
  stack: [
    s.security.jwe_encode({ as: "result" }),
  ],
  response: ref("result"),
});
