import { describe, it, expect, expectTypeOf } from "vitest";
import {
  query,
  apiGroup,
  input,
  type InferInput,
  type InferRow,
  type InferResponse,
  generatedStatements,
  encodeStatement,
  c,
  lam,
  assertLambdaBody,
  LAMBDA_BINDINGS,
  LAMBDA_CODE_FILTERS,
  LAMBDA_STATEMENTS,
  LAMBDA_GLOBALS,
  type LambdaBody,
  type LambdaBindings,
  type LambdaSurface,
  type LambdaOptions,
  type CaptureValue,
  type AmbientBindings,
  type IteratingBindings,
} from "../src/index.js";
import { meQuery, login, getSnippet, fetchSnippet } from "./fixtures/consumer-example.js";
import { createLink, linksGroup } from "./fixtures/validate-input-recipe.js";
import { api, links, bumpClicks, listLinks, getLinkSlug, getLinkOrNull } from "./fixtures/docs-recipes.js";
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
    const bundle = new Xano()
      .register("api_group", linksGroup)
      .register("query", createLink)
      .export();
    const q = (bundle.payload.query as Array<{ name: string; run: Array<{ name: string }> }>).find(
      (x) => x.name === "create_link",
    );
    expect(q?.run?.some((st) => st.name === "mvp:precondition")).toBe(true);
    expectTypeOf<InferInput<typeof createLink>>().toEqualTypeOf<{ url: string }>();
  });

  it("the docs recipes fixture exports (#13: array column, tableRef opts, unique index, increment)", () => {
    const bundle = new Xano()
      .register("api_group", api)
      .register("table", links)
      .register("query", bumpClicks)
      .export();
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
    // list endpoint → row list; column-narrowed get → Pick | null; get → Row | null (#105).
    expectTypeOf<InferResponse<typeof listLinks>>().toEqualTypeOf<InferRow<typeof links>[]>();
    expectTypeOf<InferResponse<typeof getLinkSlug>>().toEqualTypeOf<
      Pick<InferRow<typeof links>, "id" | "url"> | null
    >();
    expectTypeOf<InferResponse<typeof getLinkOrNull>>().toEqualTypeOf<
      InferRow<typeof links> | null
    >();
  });
});

/**
 * The generated factory tree mirrors the engine's schema-file layout, EXCEPT
 * where `NAMESPACE_OVERRIDES` in `scripts/codegen.ts` re-homes a statement onto
 * the surface SideStep chose for it. The override lives in codegen so a
 * regeneration reproduces it; this guards the committed result, which is what
 * consumers of `generatedStatements` actually reach.
 */
describe("generated factory tree namespace overrides", () => {
  it("files the microservice call under `microservice.request`, not `api`", () => {
    expect(typeof generatedStatements.microservice.request).toBe("function");
    expect("microservice" in generatedStatements.api).toBe(false);
  });

  it("re-homing moved the factory rather than duplicating it", () => {
    const enc = encodeStatement(
      generatedStatements.microservice.request({
        host: c.text("svc"),
        path: c.text("/p"),
        method: "GET",
        params: c.obj({}),
        headers: c.array([]),
        timeout: c.int(10),
        follow_location: c.bool(true),
      }),
    );
    expect(enc.name).toBe("mvp:microservice_request");
  });
});

/**
 * The lambda authoring surface is reachable from the package entry — including
 * its TYPES, which is the half a runtime check cannot see.
 *
 * `LambdaBody` shipped in the emitted signatures before it shipped as an export,
 * so a consumer could use the inline form but could not NAME its type to write a
 * shared body. Caught by type-checking a consumer against the built `.d.ts`, and
 * pinned here so it stays exported.
 */
describe("lambda authoring surface (issue #221)", () => {
  it("exports the authoring values", () => {
    expect(typeof lam.fn).toBe("function");
    expect(typeof lam.raw).toBe("function");
    expect(typeof assertLambdaBody).toBe("function");
    expect(LAMBDA_BINDINGS.reduce).toContain("$result");
    expect(LAMBDA_CODE_FILTERS.reduce?.surface).toBe("reduce");
    expect(LAMBDA_STATEMENTS["mvp:lambda"]?.surface).toBe("s.lambda");
    expect(LAMBDA_GLOBALS).toContain("console");
  });

  it("exports every type a consumer needs to name one", () => {
    // A shared body, typed for a surface, written the way a consumer would.
    const body: LambdaBody<"map"> = ({ $this }) => $this;
    const surface: LambdaSurface = "reduce";
    const opts: LambdaOptions = { surface };
    const capture: CaptureValue = { rate: 0.2 };
    expectTypeOf<LambdaBindings<"reduce">>().toHaveProperty("$result");
    expectTypeOf<LambdaBindings<"s.lambda">>().not.toHaveProperty("$this");
    expectTypeOf<AmbientBindings>().toHaveProperty("$var");
    expectTypeOf<IteratingBindings>().toHaveProperty("$parent");
    expect([typeof body, surface, opts.surface, typeof capture]).toEqual(["function", "reduce", "reduce", "object"]);
  });
});
