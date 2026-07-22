/**
 * `s.cloud.elasticsearch.query` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const cloudElasticsearchQuery = defineFunction({
  name: "ex_cloud_elasticsearch_query",
  stack: [
    s.cloud.elasticsearch.query({ as: "result" }),
  ],
  response: ref("result"),
});
