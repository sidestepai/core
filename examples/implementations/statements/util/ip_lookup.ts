/**
 * `s.util.ip_lookup` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const utilIpLookup = defineFunction({
  name: "ex_util_ip_lookup",
  stack: [
    s.util.ip_lookup({ as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
