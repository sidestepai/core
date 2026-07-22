/**
 * `s.util.set_header` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@sidestep/core";

export const utilSetHeader = defineFunction({
  name: "ex_util_set_header",
  stack: [
    s.util.set_header({ value: c.text("example") }),
  ],
});
