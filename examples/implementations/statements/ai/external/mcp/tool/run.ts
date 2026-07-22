/**
 * `s.ai.external.mcp.tool.run` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const aiExternalMcpToolRun = defineFunction({
  name: "ex_ai_external_mcp_tool_run",
  stack: [
    s.ai.external.mcp.tool.run({ as: "result" }),
  ],
  response: ref("result"),
});
