/**
 * `s.storage.create_image` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, input, ref, s } from "@sidestep/core";

/**
 * The upload → store → write flow, which is the only way a file reaches a column.
 *
 * `input.file()` is the raw upload: the request's bytes. It is NOT a stored file
 * resource, so it cannot be written to an `f.image()` column directly.
 * `s.storage.create_image` stores it and yields the resource that can be —
 * here bound to `img` and returned.
 */
export const storageCreateImage = defineFunction({
  name: "ex_storage_create_image",
  input: { upload: input.file({ required: true }) },
  stack: [
    s.storage.create_image({ as: "img", value: ref("input.upload"), filename: c.text("avatar.png") }),
  ],
  response: ref("img"),
});
