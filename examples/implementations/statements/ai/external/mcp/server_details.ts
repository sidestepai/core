/**
 * `s.ai.external.mcp.server_details` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const aiExternalMcpServerDetails = defineFunction({
  name: "ex_ai_external_mcp_server_details",
  stack: [
    s.ai.external.mcp.server_details({ as: "result" }),
  ],
  response: ref("result"),
});
