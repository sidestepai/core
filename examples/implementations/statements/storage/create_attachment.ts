/**
 * `s.storage.create_attachment` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const storageCreateAttachment = defineFunction({
  name: "ex_storage_create_attachment",
  stack: [
    s.storage.create_attachment({ as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
