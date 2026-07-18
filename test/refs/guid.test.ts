import { describe, it, expect } from "vitest";
import { deriveGuid, resolveRef } from "../../src/refs/guid.js";
import { Xano } from "../../src/workspace/xano.js";
import { defineFunction } from "../../src/function/define.js";
import "../../src/index.js"; // register kinds

describe("cross-object reference guids", () => {
  it("deriveGuid is deterministic, 32-char lowercase hex", () => {
    const g = deriveGuid("function", "get_user");
    expect(g).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveGuid("function", "get_user")).toBe(g);
  });

  it("namespaces by type so same name across kinds never collides", () => {
    expect(deriveGuid("function", "x")).not.toBe(deriveGuid("query", "x"));
    expect(deriveGuid("function", "a")).not.toBe(deriveGuid("function", "b"));
  });

  it("resolveRef accepts a bare name or a def handle, identically", () => {
    const byName = resolveRef("function", "get_user");
    const byHandle = resolveRef("function", { name: "get_user" });
    expect(byHandle).toBe(byName);
    expect(byName).toBe(deriveGuid("function", "get_user"));
  });

  it("resolveRef throws on a nameless target", () => {
    expect(() => resolveRef("function", { name: "" })).toThrow(/no name/);
  });

  it("Xano.export emits the same guid on a function that a reference resolves to", () => {
    const getUser = defineFunction({ name: "get_user", stack: [] });
    const bundle = new Xano().registerFunctions([getUser]).export();
    const fn = (bundle.payload.function as Array<{ name: string; guid: string }>)[0]!;
    expect(fn.guid).toBe(resolveRef("function", getUser));
  });

  it("an explicit `guid` anchors identity so renaming `name` keeps the same guid", () => {
    // Two functions with different display names but the same guid are one object.
    const v1 = defineFunction({ guid: "fn_get_user", name: "Get User", stack: [] });
    const v2 = defineFunction({ guid: "fn_get_user", name: "Get User v2", stack: [] });
    expect(resolveRef("function", v1)).toBe("fn_get_user");
    expect(resolveRef("function", v2)).toBe("fn_get_user");
    // The emitted guid is the explicit one, used verbatim (not name-derived).
    const bundle = new Xano().registerFunctions([v2]).export();
    const fn = (bundle.payload.function as Array<{ name: string; guid: string }>)[0]!;
    expect(fn.name).toBe("Get User v2");
    expect(fn.guid).toBe("fn_get_user");
  });

  it("a reference resolves to a target's explicit guid (not its name-derived one)", () => {
    const target = { name: "users", guid: "existing-app-guid" };
    expect(resolveRef("app", target)).toBe("existing-app-guid");
    expect(resolveRef("app", "users")).toBe(deriveGuid("app", "users")); // bare name → derived
  });
});
