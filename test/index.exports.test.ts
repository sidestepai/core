import { describe, it, expect, expectTypeOf } from "vitest";
import { query, apiGroup, input, type InferInput } from "../src/index.js";
import { meQuery, login } from "./fixtures/consumer-example.js";

/**
 * U4 — the consumer contract is reachable from the package entry point, and the
 * documented example wires together.
 */
describe("public consumer surface", () => {
  it("query().getPath is callable from the package entry", () => {
    const g = apiGroup({ name: "auth", canonical: "auth" });
    const q = query({ name: "me", verb: "POST", apiGroup: g, input: { email: input.email() } });
    expect(typeof q.getPath).toBe("function");
    expect(q.getPath()).toBe("/api:auth/me");
  });

  it("InferInput resolves from an entry-point-imported query", () => {
    const g = apiGroup({ name: "auth", canonical: "auth" });
    const q = query({
      name: "me",
      verb: "POST",
      apiGroup: g,
      input: { email: input.email({ required: true }), age: input.int() },
    });
    expect(q.getPath()).toBe("/api:auth/me");
    expectTypeOf<InferInput<typeof q>>().toEqualTypeOf<{ email: string; age?: number }>();
  });

  it("the README consumer fixture exposes a usable query + login()", () => {
    expect(meQuery.getPath()).toBe("/api:auth/me");
    expect(meQuery.verb).toBe("POST");
    expect(typeof login).toBe("function");
    expectTypeOf<InferInput<typeof meQuery>>().toEqualTypeOf<{
      email: string;
      password: string;
    }>();
  });
});
