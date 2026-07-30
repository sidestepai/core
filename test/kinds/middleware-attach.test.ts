import { describe, it, expect } from "vitest";
import {
  encodeMiddlewareEntry,
  buildMiddlewareBlock,
  encodeMiddlewareList,
  clear,
} from "../../src/kinds/middleware-attach.js";
import { middleware } from "../../src/kinds/middleware.js";
import { emptyMiddleware } from "../../src/kinds/common.js";
import { deriveGuid } from "../../src/refs/guid.js";

describe("middleware attachment", () => {
  it("encodes an entry to the full mvp:middleware stack-item envelope", () => {
    const entry = encodeMiddlewareEntry("audit");
    // The full 12-key StackItemXdo envelope (matches a persisted golden's middleware.pre[0]).
    expect(entry).toEqual({
      name: "mvp:middleware",
      as: "",
      _xsid: "",
      addon: [],
      input: [],
      mocks: {},
      output: { items: [], filters: [], customize: false },
      context: { middleware: { id: deriveGuid("middleware", "audit") } },
      runtime: null,
      disabled: false,
      description: "",
      settings_registry: null,
    });
  });

  it("resolves a def handle's explicit guid verbatim (not the name derivation)", () => {
    const mw = middleware({ name: "audit", guid: "abc123def456" });
    const entry = encodeMiddlewareEntry(mw);
    expect((entry.context as { middleware: { id: string } }).middleware.id).toBe("abc123def456");
  });

  it("marks active:false as disabled and omits disabled otherwise", () => {
    expect(encodeMiddlewareEntry({ middleware: "guard", active: false }).disabled).toBe(true);
    expect(encodeMiddlewareEntry({ middleware: "guard", active: true }).disabled).toBe(false);
    expect(encodeMiddlewareEntry("guard").disabled).toBe(false);
  });

  it("presence-driven customize resolves pre/post independently", () => {
    // post present, pre absent → only post customized.
    const b1 = buildMiddlewareBlock({ post: ["audit"] });
    expect(b1.post_customize).toBe(true);
    expect(b1.pre_customize).toBe(false);
    expect(b1.post).toHaveLength(1);
    expect(b1.pre).toEqual([]);

    // pre present (empty) → override-with-nothing; post absent → inherit.
    const b2 = buildMiddlewareBlock({ pre: [] });
    expect(b2.pre_customize).toBe(true);
    expect(b2.pre).toEqual([]);
    expect(b2.post_customize).toBe(false);
  });

  it("preserves entry order in a multi-entry phase", () => {
    const b = buildMiddlewareBlock({ pre: ["a", "b", "c"] });
    const ids = b.pre.map((e) => (e as { context: { middleware: { id: string } } }).context.middleware.id);
    expect(ids).toEqual([
      deriveGuid("middleware", "a"),
      deriveGuid("middleware", "b"),
      deriveGuid("middleware", "c"),
    ]);
  });

  it("undefined attach is byte-identical to emptyMiddleware()", () => {
    expect(buildMiddlewareBlock(undefined)).toEqual(emptyMiddleware());
  });

  it("middleware.clear() is an explicit empty override", () => {
    const b = buildMiddlewareBlock({ pre: middleware.clear() });
    expect(b.pre_customize).toBe(true);
    expect(b.pre).toEqual([]);
    expect(clear()).toEqual([]);
  });

  it("encodeMiddlewareList encodes a bare list (workspace tier)", () => {
    expect(encodeMiddlewareList()).toEqual([]);
    expect(encodeMiddlewareList(["a", "b"])).toHaveLength(2);
  });
});
