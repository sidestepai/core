/**
 * `setting(name)` — reference a workspace setting.
 */
import { defineFunction, s, setting, ref } from "@sidestep/core";

export const valueSetting = defineFunction({
  name: "ex_value_setting",
  stack: [s.set_var("region", setting("default_region"))],
  response: ref("region"),
});
