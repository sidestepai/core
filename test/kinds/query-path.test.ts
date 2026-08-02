import { describe, it, expect, expectTypeOf } from "vitest";
import { query, encodeQuery } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { input } from "../../src/inputs/input.js";
import { f } from "../../src/fields/catalog.js";
import type { InferInput } from "../../src/inputs/infer.js";

/**
 * U3 — generic `query()` + `getPath()`. Covers path resolution, the canonical
 * fallbacks and errors, name normalization, that the value brands survive on
 * `typeof theQuery` (so `InferInput` still resolves), and that attaching
 * `getPath` did not change the encoded XDO or JSON serialization.
 */

const auth = apiGroup({ name: "auth", canonical: "auth" });

const meQuery = query({
  name: "me",
  verb: "POST",
  apiGroup: auth,
  input: {
    email: input.email({ required: true }),
    password: input.password({ required: true }),
  },
});

describe("query().getPath()", () => {
  it("returns the group-relative path from the api group handle's canonical", () => {
    expect(meQuery.getPath()).toBe("/api:auth/me");
  });

  it("normalizes a leading slash and preserves nested path segments", () => {
    const leading = query({ name: "/me", verb: "GET", apiGroup: auth });
    expect(leading.getPath()).toBe("/api:auth/me");

    const nested = query({ name: "auth/me", verb: "GET", apiGroup: auth });
    expect(nested.getPath()).toBe("/api:auth/auth/me");
  });

  it("an explicit canonical override wins over the handle's canonical", () => {
    expect(meQuery.getPath({ canonical: "v2" })).toBe("/api:v2/me");
  });

  it("throws for a bare-name apiGroup (no canonical resolvable) unless overridden", () => {
    const byName = query({ name: "me", verb: "GET", apiGroup: "auth" });
    expect(() => byName.getPath()).toThrow(/cannot resolve the api group's canonical/);
    // …but an override makes it resolvable.
    expect(byName.getPath({ canonical: "auth" })).toBe("/api:auth/me");
  });

  it("throws for an api group with an empty canonical and no seeded lock", () => {
    const empties = apiGroup({ name: "public" }); // canonical defaults to ""
    const q = query({ name: "list", verb: "GET", apiGroup: empties });
    // No fresh minting at getPath() time — canonicals are minted only at
    // `export --lock` (unique per instance across all workspaces).
    expect(() => q.getPath()).toThrow(/export --lock/);
  });

  it("throws when the query has no api group at all", () => {
    const q = query({ name: "orphan", verb: "GET" });
    expect(() => q.getPath()).toThrow(/cannot resolve/);
  });

  it("keeps the HTTP verb accessible on the handle", () => {
    expect(meQuery.verb).toBe("POST");
  });
});

describe("query() preserves input brands for InferInput", () => {
  it("typeof theQuery yields the precise request-payload type", () => {
    expectTypeOf<InferInput<typeof meQuery>>().toEqualTypeOf<{
      email: string;
      password: string;
    }>();
  });

  it("a no-input query infers an empty payload (no index-signature leak)", () => {
    const ping = query({ name: "ping", verb: "GET", apiGroup: auth });
    expect(ping.getPath()).toBe("/api:auth/ping");
    expectTypeOf<keyof InferInput<typeof ping>>().toEqualTypeOf<never>();
    const empty: InferInput<typeof ping> = {};
    void empty;
  });
});

describe("attaching getPath does not disturb encoding/serialization", () => {
  it("encodeQuery output is unchanged and carries no getPath", () => {
    const enc = encodeQuery(meQuery);
    expect(enc.name).toBe("me");
    expect(enc.verb).toBe("POST");
    expect(enc.input.map((i) => i.name)).toEqual(["email", "password"]);
    expect(Object.keys(enc)).not.toContain("getPath");
  });

  it("JSON.stringify(theQuery) drops the getPath method", () => {
    const round = JSON.parse(JSON.stringify(meQuery));
    expect(round.getPath).toBeUndefined();
    expect(round.name).toBe("me");
  });

  it("encoding the factory return equals encoding the bare def", () => {
    const bare = { name: "me", verb: "POST" as const, apiGroup: auth, input: meQuery.input };
    expect(encodeQuery(meQuery)).toEqual(encodeQuery(bare));
  });
});

/**
 * U2/U3/U4 — URL path params. `{param}` segments in the name are bound to
 * required scalar inputs, filled by `getPath({ params })`, and dropped from the
 * GET query string.
 */
const blog = apiGroup({ name: "blog", canonical: "blog" });

const post = query({
  name: "blog/{slug}",
  verb: "GET",
  apiGroup: blog,
  input: { slug: input.text({ required: true }) },
});

const review = query({
  name: "blog/{slug}/review/{review_id}",
  verb: "GET",
  apiGroup: blog,
  input: {
    slug: input.text({ required: true }),
    review_id: input.int({ required: true }),
  },
});

describe("query() enforces the path↔input contract", () => {
  it("constructs when every {param} is a required scalar input", () => {
    expect(post.name).toBe("blog/{slug}");
    expect(review.name).toBe("blog/{slug}/review/{review_id}");
  });

  it("throws at the query() call when a {param} has no input", () => {
    expect(() =>
      query({ name: "blog/{slug}", verb: "GET", apiGroup: blog }),
    ).toThrow(/no `slug` input/);
  });

  it("does not demand `required: true` — the engine's own editor leaves path inputs unmarked", () => {
    const loose = query({
      name: "blog/{slug}",
      verb: "GET",
      apiGroup: blog,
      input: { slug: input.text() },
    });
    expect(encodeQuery(loose).input[0]).toMatchObject({ name: "slug", required: false });
  });

  it("throws at the query() call for a non-scalar path param", () => {
    expect(() =>
      query({
        name: "blog/{slug}",
        verb: "GET",
        apiGroup: blog,
        input: { slug: input.object({ a: f.text() }) },
      }),
    ).toThrow(/cannot be an `obj`/);
  });

  it("accepts a partial-segment marker — the engine routes it", () => {
    // Was asserted as a throw. The router substitutes each marker in place and
    // matches the whole action string, so `post-{slug}` is a real route; the old
    // rule refused it and named it as the canonical mistake.
    const q = query({
      name: "blog/post-{slug}",
      verb: "GET",
      apiGroup: blog,
      input: { slug: input.text({ required: true }) },
    });
    expect(q.name).toBe("blog/post-{slug}");
  });

  it("throws for a marker that never closes, which routes nothing", () => {
    expect(() =>
      query({
        name: "blog/{slug",
        verb: "GET",
        apiGroup: blog,
        input: { slug: input.text({ required: true }) },
      }),
    ).toThrow(/unmatched brace/);
  });

  it("leaves non-path inputs alone — they are query-string/body params", () => {
    const listed = query({
      name: "blog/{slug}",
      verb: "GET",
      apiGroup: blog,
      input: { slug: input.text({ required: true }), page: input.int() },
    });
    expect(encodeQuery(listed).input.map((i) => i.name)).toEqual(["slug", "page"]);
  });

  it("encodeQuery re-checks, so a hand-built def cannot route around the guard", () => {
    expect(() => encodeQuery({ name: "blog/{slug}", verb: "GET" })).toThrow(/no `slug` input/);
  });

  it("stores the name verbatim — path params are a naming convention, not a new field", () => {
    const enc = encodeQuery(review);
    expect(enc.name).toBe("blog/{slug}/review/{review_id}");
    expect(enc.input.map((i) => i.name)).toEqual(["slug", "review_id"]);
    expect(Object.keys(enc)).not.toContain("params");
  });
});

describe("getPath() fills {param} segments", () => {
  it("returns a fetch-ready path", () => {
    expect(post.getPath({ params: { slug: "hello" } })).toBe("/api:blog/blog/hello");
  });

  it("fills chained params and stringifies a number", () => {
    expect(review.getPath({ params: { slug: "x", review_id: 7 } })).toBe(
      "/api:blog/blog/x/review/7",
    );
  });

  it("composes with a canonical override in one call", () => {
    expect(post.getPath({ canonical: "v2", params: { slug: "hello" } })).toBe("/api:v2/blog/hello");
  });

  it("throws when params are omitted", () => {
    // @ts-expect-error — `params` is required for a path that declares one
    expect(() => post.getPath()).toThrow(/needs a value for the path param `slug`/);
  });

  it("throws on an empty value, an unknown key, and a value containing a slash", () => {
    expect(() => post.getPath({ params: { slug: "" } })).toThrow(/needs a value/);
    expect(() =>
      post.getPath({ params: { slugg: "x" } as unknown as { slug: string } }),
    ).toThrow(/not a \{param\} segment/);
    expect(() => post.getPath({ params: { slug: "a/b" } })).toThrow(/cannot contain "\/"/);
  });

  it("still resolves canonical errors for a param-bearing name", () => {
    const orphan = query({
      name: "blog/{slug}",
      verb: "GET",
      input: { slug: input.text({ required: true }) },
    });
    expect(() => orphan.getPath({ params: { slug: "x" } })).toThrow(/cannot resolve/);
  });

  it("types the params keys from the literal name", () => {
    expectTypeOf(post.getPath).parameter(0).toMatchTypeOf<{ params: { slug: string | number } }>();
    expectTypeOf(review.getPath)
      .parameter(0)
      .toMatchTypeOf<{ params: { slug: string | number; review_id: string | number } }>();
    // A static name keeps the zero-argument call shape.
    expectTypeOf(meQuery.getPath).toBeCallableWith();
  });
});

describe("handle.toSearchParams() drops path params", () => {
  it("omits the segment-bound key and keeps the rest", () => {
    expect(post.toSearchParams({ slug: "x", page: 2 }).toString()).toBe("page=2");
  });

  it("drops every chained param", () => {
    expect(review.toSearchParams({ slug: "x", review_id: 7, sort: "new" }).toString()).toBe(
      "sort=new",
    );
  });

  it("matches the free function for a static name", () => {
    expect(meQuery.toSearchParams({ email: "a@b.c" }).toString()).toBe(
      query.toSearchParams({ email: "a@b.c" }).toString(),
    );
  });

  it("leaves the free function's behavior untouched", () => {
    expect(query.toSearchParams({ slug: "x", page: 2 }).toString()).toBe("slug=x&page=2");
  });

  it("still throws on a non-serializable value", () => {
    expect(() => post.toSearchParams({ page: {} as unknown as number })).toThrow(/not a scalar/);
    expect(() => post.toSearchParams({ page: NaN })).toThrow(/finite/);
  });
});
