/**
 * `s.redis.set` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@sidestep/core";

export const redisSet = defineFunction({
  name: "ex_redis_set",
  stack: [
    s.redis.set({ key: c.text("••••"), data: c.text("example") }),
  ],
});
