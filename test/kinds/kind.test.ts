import { describe, it, expect } from "vitest";
import {
  registerKind,
  getKind,
  encodeObject,
  isRegisteredKind,
  registeredKinds,
} from "../../src/kinds/kind.js";
import type { ObjectKind } from "../../src/kinds/kind.js";
import "../../src/kinds/function.js"; // ensure function kind is registered

describe("object-kind registry", () => {
  it("routes encodeObject through the registered kind's encoder", () => {
    const fake: ObjectKind<{ v: number }, { doubled: number }> = {
      name: "test:double",
      payloadKey: "double",
      encode: (def) => ({ doubled: def.v * 2 }),
    };
    registerKind(fake);
    expect(isRegisteredKind("test:double")).toBe(true);
    expect(encodeObject("test:double", { v: 21 })).toEqual({ doubled: 42 });
    expect(getKind("test:double")).toBe(fake);
  });

  it("throws a clear error for an unknown kind", () => {
    expect(() => getKind("test:nope")).toThrow(/Unknown object kind/);
    expect(() => encodeObject("test:nope", {})).toThrow(/Unknown object kind/);
  });

  it("registers the function kind under payload key 'function'", () => {
    expect(isRegisteredKind("function")).toBe(true);
    expect(getKind("function").payloadKey).toBe("function");
  });

  it("exposes all registered kinds for export assembly", () => {
    const names = registeredKinds().map((k) => k.name);
    expect(names).toContain("function");
  });

  it("encodes two kinds independently", () => {
    const a: ObjectKind = { name: "test:a", payloadKey: "a", encode: () => ({ k: "a" }) };
    const b: ObjectKind = { name: "test:b", payloadKey: "b", encode: () => ({ k: "b" }) };
    registerKind(a);
    registerKind(b);
    expect(encodeObject("test:a", {})).toEqual({ k: "a" });
    expect(encodeObject("test:b", {})).toEqual({ k: "b" });
  });
});
