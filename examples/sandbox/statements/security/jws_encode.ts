/**
 * `s.security.jws_encode` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityJwsEncode = defineFunction({
  name: "ex_security_jws_encode",
  stack: [
    s.security.jws_encode({ as: "result", signature_algorithm: "PS256" }),
  ],
  response: ref("result"),
});
