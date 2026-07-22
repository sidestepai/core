/**
 * `withFilters(value, ...filters)` — attach a filter chain to a value. Chain
 * multiple filters; each reshapes the value in the engine's `filters[]` pipeline.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const valueWithFilters = defineFunction({
  name: "ex_value_with_filters",
  stack: [s.set_var("slug", withFilters(c.text("  Hello World  "), fl.trim(), fl.lower(), fl.replace(c.text(" "), c.text("-"))))],
  response: ref("slug"),
});
