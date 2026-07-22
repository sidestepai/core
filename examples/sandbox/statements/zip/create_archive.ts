/**
 * `s.zip.create_archive` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const zipCreateArchive = defineFunction({
  name: "ex_zip_create_archive",
  stack: [
    s.zip.create_archive({ as: "result", filename: c.text("example") }),
  ],
  response: ref("result"),
});
