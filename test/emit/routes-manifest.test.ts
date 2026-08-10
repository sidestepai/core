/**
 * The generated route manifest (`sidestep routes --emit`, issue #223).
 *
 * The manifest exists so a frontend can keep the "derive paths, never hardcode"
 * contract without paying ~37 kB of core runtime for one `getPath()`. That only
 * holds if the generated interpolator agrees with `getPath()` exactly — a
 * manifest that formats a path differently, or accepts an input `getPath()`
 * rejects, silently addresses the wrong route. So the load-bearing test here is
 * equivalence against the real def, not a snapshot of the emitted text.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { apiGroup } from "../../src/kinds/api-group.js";
import { query } from "../../src/kinds/query.js";
import { input } from "../../src/inputs/input.js";
import { c } from "../../src/values/value.js";
import { renderRouteManifest, RouteManifestError } from "../../src/emit/routes-manifest.js";

const app = apiGroup({ name: "app", canonical: "app" });
const blog = apiGroup({ name: "blog", canonical: "blog" });

const login = query({
  name: "auth/login",
  verb: "POST",
  apiGroup: app,
  stack: [],
  response: { ok: c.bool(true) },
});
const getPost = query({
  name: "blog/{slug}",
  verb: "GET",
  apiGroup: blog,
  input: { slug: input.text({ required: true }) },
  stack: [],
  response: { ok: c.bool(true) },
});
const review = query({
  name: "blog/{slug}/review/{review_id}",
  verb: "GET",
  apiGroup: blog,
  input: { slug: input.text({ required: true }), review_id: input.int({ required: true }) },
  stack: [],
  response: { ok: c.bool(true) },
});

const ROUTES = [
  { name: login.name, verb: login.verb, canonical: "app" },
  { name: getPost.name, verb: getPost.verb, canonical: "blog" },
  { name: review.name, verb: review.verb, canonical: "blog" },
] as const;

/** Compile the generated TypeScript and import it, so the tests run the real emitted code. */
async function loadManifest(source: string): Promise<{
  ROUTES: Record<string, { verb: string; path: string }>;
  routePath: (name: string, params?: Record<string, string | number>) => string;
}> {
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  const dir = mkdtempSync(join(tmpdir(), "sidestep-routes-"));
  const file = join(dir, "routes.gen.mjs");
  writeFileSync(file, code);
  try {
    return (await import(pathToFileURL(file).href)) as never;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("renderRouteManifest", () => {
  it("emits no import of any kind — the whole point of the file", () => {
    const source = renderRouteManifest(ROUTES);
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toContain("@sidestep/core");
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("is deterministic — a re-run produces byte-identical output", () => {
    const a = renderRouteManifest(ROUTES);
    // Same routes, different input order: the emitter sorts, so a committed
    // manifest doesn't churn when registration order changes.
    const b = renderRouteManifest([ROUTES[2], ROUTES[0], ROUTES[1]]);
    expect(b).toBe(a);
  });

  it("refuses two endpoints with the same name — the manifest keys on it", () => {
    expect(() =>
      renderRouteManifest([
        { name: "dup", verb: "GET", canonical: "app" },
        { name: "dup", verb: "POST", canonical: "blog" },
      ]),
    ).toThrow(RouteManifestError);
  });

  it("carries the verb for every route", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(m.ROUTES["auth/login"]!.verb).toBe("POST");
    expect(m.ROUTES["blog/{slug}"]!.verb).toBe("GET");
  });
});

describe("routePath ≡ getPath", () => {
  it("produces the identical path for a static route", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(m.routePath("auth/login")).toBe(login.getPath());
  });

  it("produces the identical path for one and for several params", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(m.routePath("blog/{slug}", { slug: "hello" })).toBe(
      getPost.getPath({ params: { slug: "hello" } }),
    );
    expect(m.routePath("blog/{slug}/review/{review_id}", { slug: "hello", review_id: 7 })).toBe(
      review.getPath({ params: { slug: "hello", review_id: 7 } }),
    );
  });

  it("agrees on values that need no escaping but look risky", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    for (const slug of ["a-b_c", "post-1.json", "ünïcode", "10", "a b"]) {
      expect(m.routePath("blog/{slug}", { slug }), slug).toBe(
        getPost.getPath({ params: { slug } }),
      );
    }
  });

  it("rejects the same inputs getPath rejects", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    const cases: { params: Record<string, string | number>; why: string }[] = [
      { params: { slug: "" }, why: "empty" },
      { params: { slug: "a/b" }, why: "contains a slash" },
      { params: { slug: Number.NaN }, why: "non-finite" },
      { params: { nope: "x" }, why: "unknown key" },
    ];
    for (const { params, why } of cases) {
      expect(() => m.routePath("blog/{slug}", params), why).toThrow();
      expect(
        // @ts-expect-error — deliberately the same bad input the manifest gets
        () => getPost.getPath({ params }),
        why,
      ).toThrow();
    }
  });

  it("rejects a missing params argument on a parameterized route", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(() => m.routePath("blog/{slug}")).toThrow(/path param/);
  });

  it("rejects an unknown route name at runtime as well as at compile time", async () => {
    const m = await loadManifest(renderRouteManifest(ROUTES));
    expect(() => m.routePath("not/a/route")).toThrow(/unknown route/);
  });
});
