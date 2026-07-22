import { describe, it, expect, afterEach } from "vitest";
import { mcpServer, encodeMcpServer, seedLockOverrides, resetLockOverrides } from "../../src/index.js";

/**
 * `mcpServer().getPath()`/`getUrl()` — the Streamable HTTP endpoint URL, derived
 * from the toolset `canonical` (mirrors `query.getPath()`). Canonical resolution
 * order and the never-mint safety rule match `resolveToolsetCanonical`.
 */
describe("mcpServer().getPath()/getUrl()", () => {
  afterEach(() => resetLockOverrides());

  it("builds the streamable-HTTP path from an in-code canonical, default token 'mcp'", () => {
    const m = mcpServer({ name: "books", canonical: "abc" });
    expect(m.getPath()).toBe("/x2/mcp/abc/mcp/stream");
  });

  it("embeds an explicit auth token in the path segment", () => {
    const m = mcpServer({ name: "books", canonical: "abc" });
    expect(m.getPath({ token: "tok123" })).toBe("/x2/mcp/abc/tok123/stream");
  });

  it("resolves the canonical minted into xano.lock under `toolset:<name>`", () => {
    seedLockOverrides({ version: 1, objects: { "toolset:notifications": { canonical: "Mint07xz" } } });
    const m = mcpServer({ name: "notifications" }); // no in-code canonical
    expect(m.getPath()).toBe("/x2/mcp/Mint07xz/mcp/stream");
  });

  it("an in-code canonical wins over the lock", () => {
    seedLockOverrides({ version: 1, objects: { "toolset:books": { canonical: "FromLock" } } });
    const m = mcpServer({ name: "books", canonical: "InCode1" });
    expect(m.getPath()).toBe("/x2/mcp/InCode1/mcp/stream");
  });

  it("an explicit getPath({ canonical }) override wins over both", () => {
    seedLockOverrides({ version: 1, objects: { "toolset:books": { canonical: "FromLock" } } });
    const m = mcpServer({ name: "books", canonical: "InCode1" });
    expect(m.getPath({ canonical: "Override" })).toBe("/x2/mcp/Override/mcp/stream");
  });

  it("getUrl() joins a base URL with no double slash", () => {
    const m = mcpServer({ name: "books", canonical: "abc" });
    expect(m.getUrl("https://x.dev.xano.io/tenant/y/")).toBe("https://x.dev.xano.io/tenant/y/x2/mcp/abc/mcp/stream");
    expect(m.getUrl("https://x.dev.xano.io/tenant/y")).toBe("https://x.dev.xano.io/tenant/y/x2/mcp/abc/mcp/stream");
  });

  it("throws (never mints) when no canonical resolves", () => {
    const m = mcpServer({ name: "books" });
    expect(() => m.getPath()).toThrow(/cannot resolve the `canonical`/);
  });

  it("the handle still encodes identically to the bare def (closures don't leak)", () => {
    const m = mcpServer({ name: "books", canonical: "abc", instructions: "expose books", tools: [{ id: 1 }] });
    const bare = encodeMcpServer({ name: "books", canonical: "abc", instructions: "expose books", tools: [{ id: 1 }] });
    expect(encodeMcpServer(m)).toEqual(bare);
    // getPath/getUrl are dropped by JSON serialization.
    expect(JSON.parse(JSON.stringify(m)).getPath).toBeUndefined();
  });
});
