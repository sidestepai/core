import { describe, it, expect, vi, afterEach } from "vitest";
import { encodeQuery } from "../../src/kinds/query.js";
import { encodeFunction } from "../../src/kinds/function.js";
import { s } from "../../src/statements/s.js";
import { expr } from "../../src/statements/conditional.js";
import { c, ref } from "../../src/values/value.js";

/**
 * Issue #1 — a query/function whose stack ends in `s.return(...)` but declares
 * no `response` compiles into an endpoint that returns nothing (the response is
 * driven only by the `response` field). `encode*` now emits a `console.warn`
 * nudge; encoding itself is unchanged (`result` stays `[]`).
 */

afterEach(() => vi.restoreAllMocks());

describe("warnUnboundReturn", () => {
  it("warns on a query with a top-level s.return and no response", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xdo = encodeQuery({
      name: "b",
      verb: "GET",
      stack: [s.set_var("posts", c.array([])), s.return(ref("posts"))],
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/returns nothing/);
    // Encoding is unchanged — the response is still empty.
    expect(xdo.result).toEqual([]);
  });

  it("warns on a function with a top-level s.return and no response", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    encodeFunction({ name: "f", stack: [s.return(ref("x"))] });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not warn when a response IS declared", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    encodeQuery({
      name: "a",
      verb: "GET",
      stack: [s.set_var("posts", c.array([])), s.return(ref("posts"))],
      response: ref("posts"),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn on a legitimate early-return nested in a conditional", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    encodeQuery({
      name: "c",
      verb: "GET",
      stack: [s.conditional({ when: expr(c.int(1), "=", c.int(1)), then: [s.return(c.int(0))] })],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when there is no return at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    encodeQuery({ name: "d", verb: "GET", stack: [s.set_var("x", c.int(1))] });
    expect(warn).not.toHaveBeenCalled();
  });
});
