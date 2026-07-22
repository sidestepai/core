/**
 * `s.security.jwe_decode_legacy` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const securityJweDecodeLegacy = defineFunction({
  name: "ex_security_jwe_decode_legacy",
  stack: [
    s.security.jwe_decode_legacy({ as: "result" }),
  ],
  response: ref("result"),
});
