/**
 * `env(name)` — reference an environment variable.
 */
import { defineFunction, s, env, ref } from "@sidestep/core";

export const valueEnv = defineFunction({
  name: "ex_value_env",
  stack: [s.set_var("apiKey", env("STRIPE_SECRET_KEY"))],
  response: ref("apiKey"),
});
