import { describe, it, expect, expectTypeOf } from "vitest";
import {
  query,
  apiGroup,
  input,
  type InferInput,
  type InferRow,
  type InferResponse,
} from "../src/index.js";
import { meQuery, login, getSnippet, fetchSnippet } from "./fixtures/consumer-example.js";
import { createLink } from "./fixtures/validate-input-recipe.js";
import { links, bumpClicks, listLinks, getLinkSlug, getLinkOrNull } from "./fixtures/docs-recipes.js";
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

  it("the docs recipes fixture exports (#13: array column, tableRef opts, unique index, increment)", () => {
    const bundle = new Xano().register("table", links).register("query", bumpClicks).export();
    const table = (bundle.payload.dbo as Array<{ name: string; index: Array<{ type: string }> }>).find(
      (t) => t.name === "links",
    );
    // The declared `unique` shorthand serialized to the engine's `btree|unique`.
    expect(table?.index?.some((i) => i.type === "btree|unique")).toBe(true);
    // `tags` is a string[] column, so InferRow surfaces it as string[].
    expectTypeOf<InferRow<typeof links>["tags"]>().toEqualTypeOf<string[]>();
    // System columns are present in InferRow.
    expectTypeOf<InferRow<typeof links>["id"]>().toEqualTypeOf<number>();
    expectTypeOf<InferRow<typeof links>["created_at"]>().toEqualTypeOf<number>();
  });

  it("the InferResponse recipes derive/override the round-trip type (#5)", () => {
    // Runtime touch so the fixtures are exercised, not just type-referenced.
    expect([listLinks.name, getLinkSlug.name, getLinkOrNull.name].every((n) => n.length > 0)).toBe(
      true,
    );
    // list endpoint → row list; column-narrowed get → Pick; override → Row | null.
    expectTypeOf<InferResponse<typeof listLinks>>().toEqualTypeOf<InferRow<typeof links>[]>();
    expectTypeOf<InferResponse<typeof getLinkSlug>>().toEqualTypeOf<
      Pick<InferRow<typeof links>, "id" | "url">
    >();
    expectTypeOf<InferResponse<typeof getLinkOrNull>>().toEqualTypeOf<
      InferRow<typeof links> | null
    >();
  });
});
