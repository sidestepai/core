import { describe, it, expect, expectTypeOf } from "vitest";
import { query, apiGroup, input, type InferInput } from "../src/index.js";
import { meQuery, login, getSnippet, fetchSnippet } from "./fixtures/consumer-example.js";
import { createLink } from "./fixtures/validate-input-recipe.js";
import { Xano } from "../src/workspace/xano.js";

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

  it("the GET fixture derives its payload and builds a query string (#6)", () => {
    expect(getSnippet.verb).toBe("GET");
    expect(typeof fetchSnippet).toBe("function");
    expectTypeOf<InferInput<typeof getSnippet>>().toEqualTypeOf<{ id: number }>();
  });

  it("the validate-at-the-boundary recipe fixture exports with its precondition (#12)", () => {
    const bundle = new Xano().register("query", createLink).export();
    const q = (bundle.payload.query as Array<{ name: string; run: Array<{ name: string }> }>).find(
      (x) => x.name === "create_link",
    );
    expect(q?.run?.some((st) => st.name === "mvp:precondition")).toBe(true);
    expectTypeOf<InferInput<typeof createLink>>().toEqualTypeOf<{ url: string }>();
  });
});
