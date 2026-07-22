/**
 * `s.cloud.google.storage.sign_url` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const cloudGoogleStorageSignUrl = defineFunction({
  name: "ex_cloud_google_storage_sign_url",
  stack: [
    s.cloud.google.storage.sign_url({ as: "result", service_account: c.text("example"), bucket: c.text("example"), filePath: c.text("example"), method: c.text("example"), ttl: c.int(1) }),
  ],
  response: ref("result"),
});
