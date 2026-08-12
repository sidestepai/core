import { describe, it, expect, vi, afterEach } from "vitest";
import { encodeQuery } from "../../src/kinds/query.js";
import { encodeFunction } from "../../src/kinds/function.js";
import { s } from "../../src/statements/s.js";
import { expr } from "../../src/statements/conditional.js";
import { c, ref } from "../../src/values/value.js";

/**
 * A query/function whose stack ends in `s.return(...)` but declares no
 * `response` encodes with an EMPTY response envelope (`result: []`), so its
 * shape is invisible to `InferResponse`, to a typed frontend, and to codegen.
 * `encode*` emits a `console.warn` nudge; encoding itself is unchanged.
 *
 * The warning used to say the endpoint "returns nothing". It does not: probed
 * against a live ephemeral environment, a query whose whole stack is
 * `s.return(c.text("done"))` answers `200 "done"` over HTTP, and an early
 * `s.return` that fires beats a declared `response`. The nudge is about the
 * missing TYPE, not a missing value — telling an author their endpoint returns
 * nothing when it plainly does is the kind of unverified claim this SDK is
 * supposed to be removing (see issue #221's binding contract).
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
    const message = String(warn.mock.calls[0]?.[0]);
    // Says the true thing: the value comes back, the TYPE does not.
    expect(message).toMatch(/DOES\s+come back at runtime/);
    expect(message).toMatch(/InferResponse/);
    expect(message).not.toMatch(/returns nothing/);
    // Encoding is unchanged — the stored response envelope is still empty, which
    // is exactly why the shape is invisible to the SDK.
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
