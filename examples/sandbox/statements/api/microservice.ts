/**
 * `s.api.microservice` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@sidestep/core";

export const apiMicroservice = defineFunction({
  name: "ex_api_microservice",
  stack: [
    s.api.microservice({ as: "result", host: c.text("example"), path: c.text("example"), method: "GET", params: c.obj({}), headers: c.obj({}), timeout: c.int(1), follow_location: c.text("example") }),
  ],
  response: ref("result"),
});
