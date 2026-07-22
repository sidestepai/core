/**
 * `s.action.package.call({ action, package?, input?, as? })` — invoke an
 * action-package operation.
 */
import { defineFunction, s, c, ref } from "@sidestep/core";

export const actionPackageCall = defineFunction({
  name: "ex_action_package_call",
  stack: [
    s.action.package.call({ action: "ex_pkg_op", package: "acme/utils", input: { x: c.int(1) }, as: "out" }),
  ],
  response: ref("out"),
});
