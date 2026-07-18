import { describe, it, expect } from "vitest";
import { encodeQuery, queryKind } from "../../src/kinds/query.js";
import { encodeApiGroup, apiGroupKind } from "../../src/kinds/api-group.js";
import { Xano } from "../../src/workspace/xano.js";
import { input } from "../../src/inputs/input.js";
import { setVar } from "../../src/statements/set-var.js";
import { c, ref } from "../../src/values/value.js";

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
});
