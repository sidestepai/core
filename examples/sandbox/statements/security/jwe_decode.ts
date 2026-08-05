/**
 * `s.security.jwe_decode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityJweDecode = defineFunction({
  name: "ex_security_jwe_decode",
  stack: [
    s.security.jwe_decode({ as: "result", key_algorithm: "A128KW", content_algorithm: "A128GCM" }),
  ],
  response: ref("result"),
});
