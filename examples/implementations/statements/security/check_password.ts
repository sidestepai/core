/**
 * `s.security.check_password` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityCheckPassword = defineFunction({
  name: "ex_security_check_password",
  stack: [
    s.security.check_password({ as: "result" }),
  ],
  response: ref("result"),
});
