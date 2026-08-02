/**
 * `s.cloud.elasticsearch.document` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const cloudElasticsearchDocument = defineFunction({
  name: "ex_cloud_elasticsearch_document",
  stack: [
    s.cloud.elasticsearch.document({ as: "result", key_id: c.text("••••"), access_key: c.text("••••"), index: c.text("example"), base_url: c.text("example"), doc_id: c.text("example"), doc: c.obj({}) }),
  ],
  response: ref("result"),
});
