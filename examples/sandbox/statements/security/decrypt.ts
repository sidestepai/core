/**
 * `s.security.decrypt` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityDecrypt = defineFunction({
  name: "ex_security_decrypt",
  stack: [
    s.security.decrypt({ as: "result", algorithm: "aes-128-cbc" }),
  ],
  response: ref("result"),
});
