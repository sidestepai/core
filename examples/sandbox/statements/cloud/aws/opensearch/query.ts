/**
 * `s.cloud.aws.opensearch.query` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const cloudAwsOpensearchQuery = defineFunction({
  name: "ex_cloud_aws_opensearch_query",
  stack: [
    s.cloud.aws.opensearch.query({ as: "result", auth_type: "IAM", return_type: "search" }),
  ],
  response: ref("result"),
});
