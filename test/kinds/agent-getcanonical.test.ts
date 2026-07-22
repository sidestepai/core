import { describe, it, expect, afterEach } from "vitest";
import { agent, encodeAgent, seedLockOverrides, resetLockOverrides } from "../../src/index.js";

/**
 * `agent().getCanonical()` — an agent has no public URL (it is invoked in-stack
 * via `s.ai.agent.run`, never addressed by an external client), so it exposes only
 * its resolved `canonical` token, not a `getPath()`/`getUrl()`.
 */
describe("agent().getCanonical()", () => {
  afterEach(() => resetLockOverrides());

  const llm = { type: "xano-free", prompt: "hi" } as const;

  it("returns the in-code canonical", () => {
    const a = agent({ name: "assistant", canonical: "ag1", llm });
    expect(a.getCanonical()).toBe("ag1");
  });

  it("resolves the locked canonical under `toolset:<name>`", () => {
    seedLockOverrides({ version: 1, objects: { "toolset:assistant": { canonical: "Locked99" } } });
    const a = agent({ name: "assistant", llm });
    expect(a.getCanonical()).toBe("Locked99");
  });

  it("an override wins; throws (never mints) when nothing resolves", () => {
    const a = agent({ name: "assistant", canonical: "ag1", llm });
    expect(a.getCanonical({ canonical: "Override" })).toBe("Override");
    const bare = agent({ name: "assistant", llm });
    expect(() => bare.getCanonical()).toThrow(/cannot resolve the `canonical`/);
  });

  it("exposes no getUrl/getPath (agents are not externally addressable)", () => {
    const a = agent({ name: "assistant", canonical: "ag1", llm });
    expect((a as unknown as Record<string, unknown>).getUrl).toBeUndefined();
    expect((a as unknown as Record<string, unknown>).getPath).toBeUndefined();
  });

  it("the handle still encodes identically to the bare def (closure doesn't leak)", () => {
    const a = agent({ name: "assistant", canonical: "ag1", llm });
    const bare = encodeAgent({ name: "assistant", canonical: "ag1", llm });
    expect(encodeAgent(a)).toEqual(bare);
    expect(JSON.parse(JSON.stringify(a)).getCanonical).toBeUndefined();
  });
});
