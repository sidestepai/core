/**
 * `s.cloud.aws.opensearch.document` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const cloudAwsOpensearchDocument = defineFunction({
  name: "ex_cloud_aws_opensearch_document",
  stack: [
    s.cloud.aws.opensearch.document({ as: "result", auth_type: "IAM", base_url: c.text("example"), method: "GET" }),
  ],
  response: ref("result"),
});
