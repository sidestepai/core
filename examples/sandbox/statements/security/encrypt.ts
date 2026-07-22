/**
 * `s.security.encrypt` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityEncrypt = defineFunction({
  name: "ex_security_encrypt",
  stack: [
    s.security.encrypt({ as: "result" }),
  ],
  response: ref("result"),
});
