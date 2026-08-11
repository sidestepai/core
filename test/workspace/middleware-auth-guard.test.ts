import { describe, it, expect, vi, afterEach } from "vitest";
import { Xano } from "../../src/workspace/xano.js";
import { middleware } from "../../src/kinds/middleware.js";
import { query } from "../../src/kinds/query.js";
import { task } from "../../src/kinds/task.js";
import { tool } from "../../src/kinds/toolset.js";
import { table } from "../../src/kinds/table.js";
import { defineFunction } from "../../src/function/define.js";
import "../../src/kinds/function.js"; // registers the "function" object kind
import { s } from "../../src/statements/s.js";
import { setVar } from "../../src/statements/set-var.js";
import { c, ref, auth, inp, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { f } from "../../src/fields/catalog.js";

/** A rate-limit middleware keyed per-user via auth("id") — the #81 footgun. */
const authKeyedMw = middleware({
  name: "rl",
  stack: [s.redis.ratelimit({ key: withFilters(c.text("rl:"), fl.concat(auth("id"))) })],
});
/** Same shape, but keyed by a request input — no auth() reference. */
const tenantKeyedMw = middleware({
  name: "rl_tenant",
  stack: [s.redis.ratelimit({ key: withFilters(c.text("rl:"), fl.concat(inp("tenant"))) })],
});
const userTable = table({ name: "user", auth: true, schema: { email: f.email() } });

afterEach(() => vi.restoreAllMocks());

describe("validateMiddlewareAuth (issue #81 export guard)", () => {
  it("warns (never throws) when an auth()-keyed middleware is on a query with no auth table", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = query({ name: "public_write", verb: "POST", middleware: { pre: [authKeyedMw] } });
    expect(() =>
      new Xano().registerMiddleware([authKeyedMw]).registerQueries([q]).export(),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^sidestep: middleware "rl".*query "public_write".*no auth table/s),
    );
  });

  it("stays silent when the same middleware is attached to an authenticated query", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = query({
      name: "authed_write",
      verb: "POST",
      auth: userTable,
      middleware: { pre: [authKeyedMw] },
    });
    expect(() =>
      new Xano()
        .registerTables([userTable])
        .registerMiddleware([authKeyedMw])
        .registerQueries([q])
        .export(),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns for a task (never a request identity), pre or post", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = task({ name: "nightly", middleware: { post: [authKeyedMw] } });
    expect(() =>
      new Xano().registerMiddleware([authKeyedMw]).registerTasks([t]).export(),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^sidestep: middleware "rl".*task "nightly".*scheduled\/background/s),
    );
  });

  it("warns when attached to a function — caller-dependent auth", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = defineFunction({
      name: "helper",
      stack: [setVar("x", c.int(1))],
      response: ref("x"),
      middleware: { pre: [authKeyedMw] },
    });
    expect(() =>
      new Xano().registerMiddleware([authKeyedMw]).registerFunctions([fn]).export(),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^sidestep: middleware "rl".*function "helper"/s));
  });

  it("warns when attached to a tool — caller-dependent auth", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tl = tool({ name: "search", middleware: { post: [authKeyedMw] } });
    expect(() =>
      new Xano().registerMiddleware([authKeyedMw]).registerTools([tl]).export(),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^sidestep: middleware "rl".*tool "search"/s));
  });

  it("does not fire for a middleware that does not reference auth()", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = query({ name: "public_write", verb: "POST", middleware: { pre: [tenantKeyedMw] } });
    expect(() =>
      new Xano().registerMiddleware([tenantKeyedMw]).registerQueries([q]).export(),
    ).not.toThrow();
    // Scoped to THIS guard: `tenantKeyedMw` keys on `inp("tenant")`, which a
    // middleware cannot resolve at all, so the #210 warning legitimately fires
    // here too. Asserting "no warnings whatsoever" would make this test a
    // tripwire for every unrelated guard added later.
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((m) => m.includes("references auth()"))).toHaveLength(0);
  });

  it("does not fire for a disabled attachment entry (it never runs)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = query({
      name: "public_write",
      verb: "POST",
      middleware: { pre: [{ middleware: authKeyedMw, active: false }] },
    });
    new Xano().registerMiddleware([authKeyedMw]).registerQueries([q]).export();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fire when the auth()-keyed middleware is only defined, not attached", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const q = query({ name: "public_write", verb: "POST" });
    new Xano().registerMiddleware([authKeyedMw]).registerQueries([q]).export();
    expect(warn).not.toHaveBeenCalled();
  });
});
