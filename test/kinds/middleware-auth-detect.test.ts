import { describe, it, expect } from "vitest";
import { stackReferencesAuth } from "../../src/kinds/middleware-attach.js";
import { s } from "../../src/statements/s.js";
import { c, auth, ref, inp, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";

describe("stackReferencesAuth", () => {
  it("detects a bare auth() as a statement context value", () => {
    expect(stackReferencesAuth([s.set_var("x", auth("id"))])).toBe(true);
  });

  it("detects auth() nested inside a filter chain (the composite-key idiom)", () => {
    // The canonical per-user rate-limit key: prefix + auth("id") via fl.concat.
    // auth() is a *filter argument*, not a top-level value — the walk must
    // descend filters[].arg[] to find it.
    const key = withFilters(c.text("chirp:rl:write:"), fl.concat(auth("id")));
    const stack = [
      s.redis.ratelimit({ key, max: c.int(10), ttl: c.int(30), error: c.text("Too fast.") }),
    ];
    expect(stackReferencesAuth(stack)).toBe(true);
  });

  it("detects bare auth() (no path) nested in a filter chain", () => {
    const key = withFilters(c.text("p:"), fl.concat(auth()));
    expect(stackReferencesAuth([s.redis.ratelimit({ key })])).toBe(true);
  });

  it("returns false for a stack that references no auth()", () => {
    const stack = [
      s.redis.ratelimit({ key: withFilters(c.text("p:"), fl.concat(inp("tenant"))) }),
      s.set_var("checked", ref("x")),
    ];
    expect(stackReferencesAuth(stack)).toBe(false);
  });

  it("does not false-positive on other tagged values (input/var/const)", () => {
    const stack = [s.set_var("y", inp("id")), s.set_var("z", c.text("auth"))];
    expect(stackReferencesAuth(stack)).toBe(false);
  });

  it("is false for undefined and empty stacks", () => {
    expect(stackReferencesAuth(undefined)).toBe(false);
    expect(stackReferencesAuth([])).toBe(false);
  });
});
