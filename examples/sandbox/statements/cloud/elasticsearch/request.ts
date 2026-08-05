/**
 * `s.cloud.elasticsearch.request` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const cloudElasticsearchRequest = defineFunction({
  name: "ex_cloud_elasticsearch_request",
  stack: [
    s.cloud.elasticsearch.request({ as: "result", auth_type: "API Key", method: "POST" }),
  ],
  response: ref("result"),
});
