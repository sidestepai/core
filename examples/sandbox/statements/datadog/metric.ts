/**
 * `s.datadog.metric` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@sidestep/core";

export const datadogMetric = defineFunction({
  name: "ex_datadog_metric",
  stack: [
    s.datadog.metric({ value: c.text("example") }),
  ],
});
