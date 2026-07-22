/**
 * `s.placeholder(name)` — an unconfigured statement slot (a stub to fill later).
 */
import { defineFunction, s } from "@sidestep/core";

export const placeholder = defineFunction({
  name: "ex_placeholder",
  stack: [s.placeholder("todo_send_email")],
});
