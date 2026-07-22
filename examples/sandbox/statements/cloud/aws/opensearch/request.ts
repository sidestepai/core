/**
 * `s.cloud.aws.opensearch.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const cloudAwsOpensearchRequest = defineFunction({
  name: "ex_cloud_aws_opensearch_request",
  stack: [
    s.cloud.aws.opensearch.request({ as: "result" }),
  ],
  response: ref("result"),
});
