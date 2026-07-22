/**
 * `s.addon.call({ addon, input?, as? })` — invoke an addon as a workspace run.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const addonCall = defineFunction({
  name: "ex_addon_call",
  stack: [s.addon.call({ addon: "ex_author_addon", input: { user_id: c.int(1) }, as: "author" })],
  response: ref("author"),
});
