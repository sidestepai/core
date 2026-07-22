/**
 * `s.util.get_raw_input({ encoding?, excludeMiddleware?, as? })` — capture the
 * raw request body, optionally bypassing middleware transforms.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const utilGetRawInput = defineFunction({
  name: "ex_util_get_raw_input",
  stack: [s.util.get_raw_input({ encoding: c.text("raw"), excludeMiddleware: c.bool(true), as: "raw" })],
  response: ref("raw"),
});
