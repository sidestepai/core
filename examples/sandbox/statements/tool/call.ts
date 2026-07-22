/**
 * `s.tool.call({ tool, input?, as? })` — invoke a tool as a workspace run.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const toolCall = defineFunction({
  name: "ex_tool_call",
  stack: [s.tool.call({ tool: "ex_search_tool", input: { query: c.text("xano") }, as: "hits" })],
  response: ref("hits"),
});
