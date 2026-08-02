import { describe, it, expect } from "vitest";
import {
  parsePathParams,
  assertPathParamInputs,
  fillPathParams,
} from "../../src/kinds/path-params.js";
import { input } from "../../src/inputs/input.js";
import { f } from "../../src/fields/catalog.js";

/**
 * U1 — the shared `{param}` helper behind a query's URL path params and a
 * realtime channel's path. Parsing, the path↔input contract, and interpolation
 * live here so the two kinds cannot drift.
 */

const CTX = `query "blog/{slug}"`;

describe("parsePathParams", () => {
  it("returns [] for a static path", () => {
    expect(parsePathParams(CTX, "blog")).toEqual([]);
    expect(parsePathParams(CTX, "blog/featured")).toEqual([]);
  });

  it("extracts a single param", () => {
    expect(parsePathParams(CTX, "blog/{slug}")).toEqual(["slug"]);
  });

  it("extracts chained params in order", () => {
    expect(parsePathParams(CTX, "blog/{slug}/review/{review_id}")).toEqual(["slug", "review_id"]);
  });

  it("normalizes a leading slash exactly as the path segment does", () => {
    expect(parsePathParams(CTX, "/blog/{slug}")).toEqual(["slug"]);
  });

  it("accepts a param as the whole path", () => {
    expect(parsePathParams(CTX, "{id}")).toEqual(["id"]);
  });

  it("accepts a PARTIAL-segment param, which the engine routes fine", () => {
    // The router substitutes a capture group for each marker in place and
    // matches the whole action string, so a marker never had to own its segment.
    // This used to throw, and the message cited "blog/post-{slug}" as the
    // canonical mistake — a route the engine serves.
    expect(parsePathParams(CTX, "blog/post-{slug}")).toEqual(["slug"]);
    expect(parsePathParams(CTX, "blog/{slug}.json")).toEqual(["slug"]);
  });

  it("accepts two params in one segment, in order", () => {
    expect(parsePathParams(CTX, "blog/{a}-{b}")).toEqual(["a", "b"]);
    // Adjacent markers too: the name excludes braces, so the first cannot
    // swallow the second the way the engine's own greedy `[^/]+` would.
    expect(parsePathParams(CTX, "blog/{a}{b}")).toEqual(["a", "b"]);
  });

  it("accepts a name that is not a plain identifier", () => {
    // The engine's name pattern is `[^/]+`. A leading digit matters in
    // practice: a table named `1table` gets the generated CRUD route
    // `1table/{1table_id}`, which this rule used to refuse outright — two
    // workspaces in a live sweep failed verification on exactly that.
    expect(parsePathParams(CTX, "1table/{1table_id}")).toEqual(["1table_id"]);
    expect(parsePathParams(CTX, "blog/{sl-ug}")).toEqual(["sl-ug"]);
    expect(parsePathParams(CTX, "blog/{a b}")).toEqual(["a b"]);
  });

  it("still rejects an empty param name", () => {
    // `{}` has no name to bind an input to, so the braces survive as residue.
    expect(() => parsePathParams(CTX, "blog/{}")).toThrow(/unmatched brace/);
  });

  it("still rejects an unbalanced brace", () => {
    // The one thing worth refusing: a route that LOOKS parameterized and is not.
    expect(() => parsePathParams(CTX, "blog/{slug")).toThrow(/unmatched brace/);
    expect(() => parsePathParams(CTX, "blog/slug}")).toThrow(/unmatched brace/);
  });

  it("rejects a duplicate param name", () => {
    expect(() => parsePathParams(CTX, "a/{id}/b/{id}")).toThrow(/appears twice/);
  });
});

describe("assertPathParamInputs", () => {
  it("passes when every param has a scalar input", () => {
    expect(() =>
      assertPathParamInputs(CTX, ["slug", "review_id"], {
        slug: input.text(),
        review_id: input.int(),
      }),
    ).not.toThrow();
  });

  it("does not demand `required: true` — the engine's own editor leaves it unmarked", () => {
    expect(() => assertPathParamInputs(CTX, ["slug"], { slug: input.text() })).not.toThrow();
    expect(() =>
      assertPathParamInputs(CTX, ["slug"], { slug: input.text({ required: false }) }),
    ).not.toThrow();
  });

  it("passes for a static path with no params and no inputs", () => {
    expect(() => assertPathParamInputs(CTX, [], undefined)).not.toThrow();
  });

  it("ignores inputs that are not path params — they are query-string/body params", () => {
    expect(() =>
      assertPathParamInputs(CTX, ["slug"], {
        slug: input.text({ required: true }),
        page: input.int(),
        body: input.object({ title: f.text() }),
      }),
    ).not.toThrow();
  });

  it("throws when a param has no matching input, naming the fix", () => {
    expect(() => assertPathParamInputs(CTX, ["slug"], { page: input.int() })).toThrow(
      /\{slug\}[\s\S]*no `slug` input[\s\S]*input\.text\(\)/,
    );
  });

  it("throws when the whole input map is missing", () => {
    expect(() => assertPathParamInputs(CTX, ["slug"], undefined)).toThrow(/no `slug` input/);
  });

  it("throws for a non-scalar path param", () => {
    expect(() =>
      assertPathParamInputs(CTX, ["slug"], { slug: input.object({ a: f.text() }) }),
    ).toThrow(/cannot be an `obj`/);
    expect(() => assertPathParamInputs(CTX, ["slug"], { slug: input.json() })).toThrow(
      /cannot be a `json`/,
    );
    expect(() => assertPathParamInputs(CTX, ["slug"], { slug: input.attachment() })).toThrow(
      /cannot be a `blob`/,
    );
    expect(() => assertPathParamInputs(CTX, ["slug"], { slug: input.geo.point() })).toThrow(
      /cannot be a `geo_point`/,
    );
    expect(() => assertPathParamInputs(CTX, ["slug"], { slug: input.vector(3) })).toThrow(
      /cannot be a `vector`/,
    );
  });

  it("throws for a list path param — a URL segment holds one value", () => {
    expect(() =>
      assertPathParamInputs(CTX, ["slug"], { slug: input.list(input.text()) }),
    ).toThrow(/cannot be a list/);
  });

  it("accepts a table-reference path param — it stores as an int/uuid scalar", () => {
    expect(() =>
      assertPathParamInputs(CTX, ["author_id"], {
        author_id: input.tableRef({ name: "author" }),
      }),
    ).not.toThrow();
  });

  it("accepts the other URL-addressable scalars", () => {
    expect(() =>
      assertPathParamInputs(CTX, ["a", "b", "c", "d", "e"], {
        a: input.uuid(),
        b: input.bool(),
        c: input.decimal(),
        d: input.enum(["x", "y"]),
        e: input.timestamp(),
      }),
    ).not.toThrow();
  });
});

describe("fillPathParams", () => {
  const fill = (path: string, params?: Record<string, string | number>): string =>
    fillPathParams(CTX, "getPath()", path, params);

  it("returns a static path untouched, with or without an argument", () => {
    expect(fill("blog/featured")).toBe("blog/featured");
    expect(fill("blog/featured", {})).toBe("blog/featured");
  });

  it("fills a single param", () => {
    expect(fill("blog/{slug}", { slug: "hello" })).toBe("blog/hello");
  });

  it("fills chained params and stringifies a number", () => {
    expect(fill("blog/{slug}/review/{review_id}", { slug: "x", review_id: 7 })).toBe(
      "blog/x/review/7",
    );
  });

  it("throws when params are missing entirely, naming what is expected", () => {
    expect(() => fill("blog/{slug}")).toThrow(/needs a value for the path param `slug`/);
  });

  it("throws on an empty or nullish value", () => {
    expect(() => fill("blog/{slug}", { slug: "" })).toThrow(/needs a value/);
    expect(() =>
      fill("blog/{slug}", { slug: undefined as unknown as string }),
    ).toThrow(/needs a value/);
    expect(() => fill("blog/{slug}", { slug: null as unknown as string })).toThrow(/needs a value/);
  });

  it("throws on an unknown key and lists the declared params", () => {
    expect(() => fill("blog/{slug}", { slugg: "x" } as unknown as Record<string, string>)).toThrow(
      /`slugg`, which is not a \{param\}[\s\S]*`slug`/,
    );
  });

  it("tells a static path's caller to pass no arguments", () => {
    expect(() => fill("blog/featured", { slug: "x" })).toThrow(/path is static/);
  });

  it("throws when a value contains a slash — it would address a different route", () => {
    expect(() => fill("blog/{slug}", { slug: "a/b" })).toThrow(/cannot contain "\/"/);
  });

  it("throws on a non-finite number rather than emitting NaN", () => {
    expect(() => fill("blog/{review_id}", { review_id: NaN })).toThrow(/finite/);
    expect(() => fill("blog/{review_id}", { review_id: Infinity })).toThrow(/finite/);
  });

  it("accepts 0 and false-y-but-real values", () => {
    expect(fill("blog/{review_id}", { review_id: 0 })).toBe("blog/0");
  });
});
