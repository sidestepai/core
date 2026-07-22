/**
 * `s.util.geo_distance` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { defineFunction, ref, s } from "@sidestep/core";

export const utilGeoDistance = defineFunction({
  name: "ex_util_geo_distance",
  stack: [
    s.util.geo_distance({ as: "result" }),
  ],
  response: ref("result"),
});
