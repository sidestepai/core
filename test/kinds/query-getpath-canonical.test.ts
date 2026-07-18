import { describe, it, expect, afterEach } from "vitest";
import { query, apiGroup, seedLockOverrides, resetLockOverrides } from "../../src/index.js";

/**
 * `getPath()` canonical resolution order, and the safety rule that it never
 * mints its own token (canonicals are unique per instance across all
 * workspaces — minting belongs to `export --lock`, which freezes the value).
 */
describe("query.getPath() canonical resolution", () => {
  afterEach(() => resetLockOverrides());

  it("uses the canonical minted into xano.lock (seeded store) for a bare-name group", () => {
    seedLockOverrides({ version: 1, objects: { "app:twitter": { canonical: "Mint07xz" } } });
    const q = query({ name: "list_tweets", verb: "GET", apiGroup: "twitter" });
    expect(q.getPath()).toBe("/api:Mint07xz/list_tweets");
  });

  it("resolves the locked canonical for a handle-bound group with no in-code canonical", () => {
    seedLockOverrides({ version: 1, objects: { "app:twitter": { canonical: "Locked99" } } });
    const g = apiGroup({ name: "twitter" }); // no explicit canonical
    const q = query({ name: "create_tweet", verb: "POST", apiGroup: g });
    expect(q.getPath()).toBe("/api:Locked99/create_tweet");
  });

  it("an explicit in-code canonical wins over the lock", () => {
    seedLockOverrides({ version: 1, objects: { "app:twitter": { canonical: "FromLock" } } });
    const g = apiGroup({ name: "twitter", canonical: "InCode1" });
    const q = query({ name: "me", verb: "GET", apiGroup: g });
    expect(q.getPath()).toBe("/api:InCode1/me");
  });

  it("an explicit getPath({ canonical }) override wins over everything", () => {
    seedLockOverrides({ version: 1, objects: { "app:twitter": { canonical: "FromLock" } } });
    const g = apiGroup({ name: "twitter", canonical: "InCode1" });
    const q = query({ name: "me", verb: "GET", apiGroup: g });
    expect(q.getPath({ canonical: "Override" })).toBe("/api:Override/me");
  });

  it("throws (never mints) when no canonical is set and no lock is seeded", () => {
    const g = apiGroup({ name: "twitter" });
    const q = query({ name: "me", verb: "GET", apiGroup: g });
    expect(() => q.getPath()).toThrow(/unique per instance across all workspaces/);
  });
});
