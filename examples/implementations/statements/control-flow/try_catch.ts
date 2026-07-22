/**
 * `s.try_catch({ try, catch, finally })` — error handling. The engine maps
 * try→if, catch→else, finally→then.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const tryCatch = defineFunction({
  name: "ex_try_catch",
  stack: [
    s.set_var("result", c.text("")),
    s.try_catch({
      try: [s.update_var("result", c.text("ok"))],
      catch: [s.update_var("result", c.text("failed"))],
      finally: [s.comment("always runs")],
    }),
  ],
  response: ref("result"),
});
