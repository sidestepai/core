/**
 * `s.storage.create_image` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const storageCreateImage = defineFunction({
  name: "ex_storage_create_image",
  stack: [
    s.storage.create_image({ as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
