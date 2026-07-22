import { describe, it, expect } from "vitest";
import {
  encodeQuery,
  queryKind,
  query,
  toSearchParams,
  type SearchParamValue,
} from "../../src/kinds/query.js";
import { encodeApiGroup, apiGroupKind } from "../../src/kinds/api-group.js";
import { table } from "../../src/kinds/table.js";
import { Xano } from "../../src/workspace/xano.js";
import { input } from "../../src/inputs/input.js";
import { setVar } from "../../src/statements/set-var.js";
import { c, ref } from "../../src/values/value.js";
import { f } from "../../src/fields/catalog.js";
import { resolveRef } from "../../src/refs/guid.js";
import { middleware } from "../../src/kinds/middleware.js";

describe("query kind", () => {
  it("encodes the HTTP/function-like envelope", () => {
    const q = encodeQuery({
      name: "test",
      verb: "POST",
      apiGroupId: 4,
      input: { score: input.int() },
      stack: [setVar("x1", c.int(1))],
      response: ref("x1"),
    });
    expect(q.verb).toBe("POST");
    expect(q.app).toEqual({ id: 4 });
    expect(q.auth).toBe(false);
    expect(q.api_enabled).toBe(true);
    expect(q.response_type).toBe("standard");
    expect(q.disabled).toBe(false);
    expect(q.cache).toEqual({
      active: false,
      ttl: 3600,
      input: true,
      auth: true,
      datasource: true,
      ip: false,
      headers: [],
      env: [],
    });
    expect(q.middleware).toEqual({ pre_customize: false, post_customize: false, pre: [], post: [] });
    expect(q.history).toEqual({ inherit: true, enabled: true, limit: 100 });
    expect(q.result).toEqual([
      { filters: [], name: "", tag: "var", value: "x1", _xsid: "", disabled: false },
    ]);
    expect(q.output).toEqual([]);
    expect(q.test).toEqual([]);
  });

  it("auth can be an id; response_type stream; cache override", () => {
    const q = encodeQuery({ name: "x", verb: "GET", auth: 3, responseType: "stream", cache: { active: true } });
    expect(q.auth).toBe(3);
    expect(q.response_type).toBe("stream");
    expect(q.cache.active).toBe(true);
  });

  it("auth omitted or false resolves to no-auth", () => {
    expect(encodeQuery({ name: "x", verb: "GET" }).auth).toBe(false);
    expect(encodeQuery({ name: "x", verb: "GET", auth: false }).auth).toBe(false);
  });

  it("auth resolves an auth-table def (or its name) to the table's guid", () => {
    const user = table({ name: "user", auth: true, schema: { email: f.email() } });
    const byDef = encodeQuery({ name: "x", verb: "POST", auth: user });
    const byName = encodeQuery({ name: "x", verb: "POST", auth: "user" });
    const guid = resolveRef("dbo", user);
    expect(byDef.auth).toBe(guid);
    expect(byName.auth).toBe(guid);
    expect(typeof byDef.auth).toBe("string");
  });

  it("multiple auth tables coexist — each endpoint names its own", () => {
    const user = table({ name: "user", auth: true, schema: { email: f.email() } });
    const admin = table({ name: "admin", auth: true, schema: { email: f.email() } });
    expect(encodeQuery({ name: "x", verb: "POST", auth: user }).auth).toBe(resolveRef("dbo", user));
    expect(encodeQuery({ name: "y", verb: "POST", auth: admin }).auth).toBe(resolveRef("dbo", admin));
  });

  it("rejects the retired `auth: true` shorthand with a migration hint", () => {
    // @ts-expect-error - `true` is no longer an accepted auth value
    expect(() => encodeQuery({ name: "create_link", verb: "POST", auth: true })).toThrow(
      /auth: true.*no longer supported/,
    );
  });

  it("rejects a numeric `auth` that can't be a `dbo.id`", () => {
    // 0 is the no-api-group sentinel elsewhere; it is NOT no-auth (that's false).
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => encodeQuery({ name: "x", verb: "POST", auth: bad })).toThrow(
        /numeric `auth` must be a positive integer/,
      );
    }
  });

  it("rejects a non-auth table def at the source, naming the table", () => {
    const posts = table({ name: "posts", schema: { body: f.text() } }); // no auth: true
    expect(() => encodeQuery({ name: "x", verb: "POST", auth: posts })).toThrow(
      /table "posts" is not an auth table/,
    );
  });

  it("requires name and verb", () => {
    // @ts-expect-error - missing verb
    expect(() => encodeQuery({ name: "x" })).toThrow(/verb/);
    // @ts-expect-error - missing name
    expect(() => encodeQuery({ verb: "GET" })).toThrow(/name/);
  });

  it("lands under payload key 'query'", () => {
    expect(queryKind.payloadKey).toBe("query");
  });
});

describe("api_group kind", () => {
  it("encodes the container envelope with default CORS", () => {
    const g = encodeApiGroup({ name: "Authentication", canonical: "uhJvSvbU", swagger: true });
    expect(g.canonical).toBe("uhJvSvbU");
    expect(g.swagger).toBe(true);
    expect(g.api_group_enabled).toBe(true);
    expect(g.documentation).toEqual({ require_token: false, token: "" });
    expect(g.history).toEqual({ inherit: true, query_enabled: true, query_limit: 100 });
    expect(g.cors).toEqual({
      mode: "default",
      allowOrigins: [],
      allowHeaders: [],
      allowCredentials: false,
      maxAge: 0,
      allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false },
    });
  });

  it("applies custom CORS methods", () => {
    const g = encodeApiGroup({ name: "g", cors: { mode: "custom", allowMethods: { get: true, post: true } } });
    expect(g.cors.mode).toBe("custom");
    expect(g.cors.allowMethods).toEqual({
      delete: false,
      get: true,
      head: false,
      patch: false,
      post: true,
      put: false,
    });
  });

  it("lands under payload key 'app'", () => {
    expect(apiGroupKind.payloadKey).toBe("app");
  });
});

describe("query + api_group on Xano", () => {
  it("export places them under payload.query and payload.app", () => {
    const bundle = new Xano()
      .register("api_group", { name: "g", canonical: "abc" })
      .register("query", { name: "q", verb: "GET", apiGroupId: 1 })
      .export();
    expect(bundle.payload.query).toHaveLength(1);
    expect(bundle.payload.app).toHaveLength(1);
    expect((bundle.payload.query as any)[0].verb).toBe("GET");
  });

  it("binds a query's `apiGroup` (def or name) to the group's guid, matching the group's own guid", () => {
    const group = { name: "public" };
    const bundle = new Xano()
      .registerApiGroups([group])
      .registerQueries([
        { name: "byDef", verb: "GET", apiGroup: group },
        { name: "byName", verb: "POST", apiGroup: "public" },
        { name: "explicitWins", verb: "PUT", apiGroup: group, apiGroupId: 9 },
      ])
      .export();
    const q = bundle.payload.query as any[];
    const groupGuid = (bundle.payload.app as any[])[0].guid;
    // The query's app.id is the api group's guid — the engine remaps it to a
    // local id on import, so re-syncs map to the same group.
    expect(q.find((x) => x.name === "byDef").app.id).toBe(groupGuid);
    expect(q.find((x) => x.name === "byName").app.id).toBe(groupGuid);
    expect(q.find((x) => x.name === "explicitWins").app.id).toBe(9); // numeric override wins
  });

  it("binds a query's `auth` to the co-registered auth table's own emitted guid", () => {
    const user = table({ name: "user", auth: true, schema: { email: f.email() } });
    const bundle = new Xano()
      .registerTables([user])
      .registerQueries([
        { name: "byDef", verb: "POST", auth: user },
        { name: "byName", verb: "POST", auth: "user" },
      ])
      .export();
    const q = bundle.payload.query as any[];
    // The engine matches references by guid, so a query's stored `auth` must be
    // the exact guid the auth table emits into the `dbo` section.
    const userGuid = (bundle.payload.dbo as any[]).find((d) => d.name === "user").guid;
    expect(q.find((x) => x.name === "byDef").auth).toBe(userGuid);
    expect(q.find((x) => x.name === "byName").auth).toBe(userGuid);
  });

  it("export rejects an `auth` name that resolves to a non-auth table", () => {
    const posts = table({ name: "posts", schema: { body: f.text() } });
    const x = new Xano()
      .registerTables([posts])
      .registerQueries([{ name: "create_post", verb: "POST", auth: "posts" }]);
    expect(() => x.export()).toThrow(/references table "posts", which is not an auth table/);
  });

  it("export rejects an `auth` name that matches no registered table (typo)", () => {
    const user = table({ name: "user", auth: true, schema: { email: f.email() } });
    const x = new Xano()
      .registerTables([user])
      .registerQueries([{ name: "login", verb: "POST", auth: "usr" }]); // typo
    expect(() => x.export()).toThrow(/isn't registered on this workspace/);
  });

  it("export flags a bare-name `auth` reference to a table that pins an explicit guid", () => {
    // The table's identity is its pinned guid, but a bare name derives its guid
    // from the name alone — so the reference diverges and must be caught.
    const user = table({ name: "user", auth: true, guid: "pinned-user-guid", schema: { email: f.email() } });
    const byName = new Xano()
      .registerTables([user])
      .registerQueries([{ name: "login", verb: "POST", auth: "user" }]);
    expect(() => byName.export()).toThrow(/isn't registered on this workspace/);
    // Passing the def handle carries the pinned guid, so it resolves and validates.
    const byDef = new Xano()
      .registerTables([user])
      .registerQueries([{ name: "login", verb: "POST", auth: user }])
      .export();
    expect((byDef.payload.query as any[])[0].auth).toBe("pinned-user-guid");
  });

  describe("toSearchParams (GET transport, #6)", () => {
    it("serializes scalars, stringifying numbers and booleans", () => {
      const p = toSearchParams({ id: 7, active: true, q: "hi there" });
      expect(p.toString()).toBe("id=7&active=true&q=hi+there");
    });

    it("keeps falsy-but-present scalars (false, 0) — only null/undefined drop", () => {
      const p = toSearchParams({ active: false, count: 0 });
      expect(p.get("active")).toBe("false");
      expect(p.get("count")).toBe("0");
    });

    it("repeats the key for array values and omits null/undefined", () => {
      const p = toSearchParams({ tag: ["a", "b"], skip: undefined, none: null, page: 2 });
      expect(p.getAll("tag")).toEqual(["a", "b"]);
      expect(p.has("skip")).toBe(false);
      expect(p.has("none")).toBe(false);
      expect(p.get("page")).toBe("2");
    });

    it("skips null/undefined interior array elements and omits an empty array", () => {
      const p = toSearchParams({ tag: ["a", null, "b", undefined], empty: [] });
      expect(p.getAll("tag")).toEqual(["a", "b"]);
      expect(p.has("empty")).toBe(false);
    });

    it("throws rather than serializing a non-finite number or a non-scalar", () => {
      expect(() => toSearchParams({ n: NaN })).toThrow(/finite/);
      expect(() => toSearchParams({ n: Infinity })).toThrow(/finite/);
      // A non-scalar that slipped past the type via `any` fails loud, not "[object Object]".
      expect(() => toSearchParams({ o: {} as never })).toThrow(/not a scalar/);
    });

    it("is reachable as a static on `query`", () => {
      expect(query.toSearchParams).toBe(toSearchParams);
      expect(query.toSearchParams({ id: 1 }).toString()).toBe("id=1");
    });

    it("accepts a `SearchParamValue`-typed map (exported type stays in the barrel)", () => {
      const one: SearchParamValue = ["a", 1, true, null];
      expect(toSearchParams({ k: one }).getAll("k")).toEqual(["a", "1", "true"]);
    });

    it("accepts a generic `Record<string, unknown>` input map without a cast (#49)", () => {
      // A generic transport holds its endpoint input opaquely; the wide overload
      // takes it directly — no `as Record<string, SearchParamValue>` needed.
      const opaque: Record<string, unknown> = { id: 7, tag: ["a", "b"], skip: undefined };
      const p = toSearchParams(opaque);
      expect(p.get("id")).toBe("7");
      expect(p.getAll("tag")).toEqual(["a", "b"]);
      expect(p.has("skip")).toBe(false);
    });

    it("still throws at runtime on a non-scalar reaching it via the wide overload", () => {
      const opaque: Record<string, unknown> = { o: { nested: true } };
      expect(() => toSearchParams(opaque)).toThrow(/not a scalar/);
    });

    it("still throws at runtime on a bigint reaching it via the wide overload", () => {
      // bigint isn't a `SearchParamValue`, but the wide overload lets it in; the
      // runtime guard rejects it rather than emitting `String(10n)` → "10".
      const opaque: Record<string, unknown> = { id: 10n };
      expect(() => toSearchParams(opaque)).toThrow(/not a scalar/);
    });

    it("does not compile-guard a bad literal — the runtime is the only check", () => {
      // The wide overload accepts everything the strict one rejects, so a nested
      // object literal type-checks and is caught only at runtime (see toSearchParams
      // doc). A `@ts-expect-error` here would FAIL, pinning that documented tradeoff.
      expect(() => toSearchParams({ o: { nested: true } })).toThrow(/not a scalar/);
    });
  });
});

describe("query middleware attachment", () => {
  it("emits the empty block when no middleware is set (unchanged)", () => {
    const q = encodeQuery({ name: "q", verb: "GET" });
    expect(q.middleware).toEqual({ pre_customize: false, post_customize: false, pre: [], post: [] });
  });

  it("sets post_customize and emits the entry when post is provided", () => {
    const q = encodeQuery({ name: "q", verb: "GET", middleware: { post: ["audit"] } });
    expect(q.middleware.pre_customize).toBe(false);
    expect(q.middleware.post_customize).toBe(true);
    expect(q.middleware.pre).toEqual([]);
    expect(q.middleware.post).toHaveLength(1);
    const entry = q.middleware.post[0] as { name: string; context: { middleware: { id: string } } };
    expect(entry.name).toBe("mvp:middleware");
    expect(entry.context.middleware.id).toBe(resolveRef("middleware", "audit"));
  });

  it("preserves order and resolves both phases independently", () => {
    const q = encodeQuery({ name: "q", verb: "GET", middleware: { pre: [], post: ["a", "b"] } });
    expect(q.middleware.pre_customize).toBe(true); // present-empty override
    expect(q.middleware.pre).toEqual([]);
    const ids = (q.middleware.post as Array<{ context: { middleware: { id: string } } }>).map(
      (e) => e.context.middleware.id,
    );
    expect(ids).toEqual([resolveRef("middleware", "a"), resolveRef("middleware", "b")]);
  });

  it("middleware.clear() overrides a phase with nothing", () => {
    const q = encodeQuery({ name: "q", verb: "GET", middleware: { pre: middleware.clear() } });
    expect(q.middleware.pre_customize).toBe(true);
    expect(q.middleware.pre).toEqual([]);
  });
});

describe("api group middleware attachment", () => {
  it("defaults to the empty block", () => {
    const g = encodeApiGroup({ name: "g" });
    expect(g.middleware).toEqual({ pre_customize: false, post_customize: false, pre: [], post: [] });
  });

  it("emits a group-level pre chain queries inherit from", () => {
    const g = encodeApiGroup({ name: "g", middleware: { pre: ["tenant"] } });
    expect(g.middleware.pre_customize).toBe(true);
    expect(g.middleware.post_customize).toBe(false);
    const entry = g.middleware.pre[0] as { context: { middleware: { id: string } } };
    expect(entry.context.middleware.id).toBe(resolveRef("middleware", "tenant"));
  });
});
