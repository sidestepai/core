/**
 * `s.addon.call({ addon, input?, as? })` — invoke an addon as a workspace run.
 *
 * Pass the addon DEF, not its name. A bare name is resolved to a guid with no
 * registry visibility, so a typo produces a valid-looking reference that only
 * fails at deploy — `Invalid addon reference. Try importing: <guid>`.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";
import { authorAddon } from "../../kinds/addon.js";

export const addonCall = defineFunction({
  name: "ex_addon_call",
  stack: [s.addon.call({ addon: authorAddon, input: { user_id: c.int(1) }, as: "author" })],
  response: ref("author"),
});
