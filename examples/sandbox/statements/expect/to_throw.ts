/**
 * `s.expect.to_throw({ body, exception? })` — assert a sub-stack raises (test).
 *
 * Hosted by a `workflowTest`, like every `s.expect.*`: assertions belong there,
 * and a failure raises rather than being collected, so one left in a
 * query/function 500s the request.
 *
 * ⚠ It does not detect every engine-raised failure — a hard engine fault
 * escapes it and the assertion reports "response is ok". Assert on a throw your
 * own stack raises, as here, rather than on one you expect the engine to.
 */
import { workflowTest, s, c } from "@sidestep/core";

export const expectToThrow = workflowTest({
  name: "ex_expect_to_throw",
  stack: [
    s.expect.to_throw({
      body: [s.throw({ value: c.text("boom") })],
    }),
  ],
});
