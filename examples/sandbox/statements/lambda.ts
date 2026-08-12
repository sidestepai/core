/**
 * `s.lambda` — run a JavaScript body in the stack.
 *
 * It lives at `s.lambda`, not `s.api.lambda`: a lambda runs wherever a stack
 * runs — functions, tasks, middleware, triggers — not only in an API.
 *
 * The statement surface binds AMBIENT state only: `$var`, `$input`, `$env`,
 * `$auth` (plus the `console` and `crypto` globals). There is no `$this` here —
 * that is a filter binding, and writing it is a build error rather than an
 * undefined at runtime.
 */
import { defineFunction, ref, s, c } from "@sidestep/core";

export const apiLambda = defineFunction({
  name: "ex_api_lambda",
  stack: [
    s.set_var("subtotal", c.decimal(120.5)),
    // 144.6 — a stack variable is reached through `$var`, never as a bare `$subtotal`.
    s.lambda({
      as: "result",
      code: ({ $var }) => Math.round($var.subtotal * 1.2 * 100) / 100,
    }),
  ],
  response: ref("result"),
});
