import { describe, it, expect, afterEach } from "vitest";
import {
  realtimeServer,
  encodeRealtimeServer,
} from "../../src/kinds/realtime-server.js";
import { seedLockOverrides, resetLockOverrides } from "../../src/lock/store.js";

afterEach(() => resetLockOverrides());

describe("realtimeServer", () => {
  it("encodes a minimal def to the full stored envelope", () => {
    expect(encodeRealtimeServer({ name: "chat" })).toEqual({
      name: "chat",
      description: "",
      canonical: "",
      // A realtime server is OFF until explicitly enabled — unlike most
      // `enabled` fields in the SDK.
      enabled: false,
      history: { inherit: true, message_enabled: false, message_limit: 100 },
      tag: [],
    });
  });

  it("requires a name", () => {
    expect(() => encodeRealtimeServer({ name: "" })).toThrow(/`name` is required/);
  });

  it("round-trips every authored field", () => {
    expect(
      encodeRealtimeServer({
        name: "chat",
        description: "team chat",
        enabled: true,
        canonical: "abc123",
        tags: ["realtime", "chat"],
      }),
    ).toMatchObject({
      description: "team chat",
      enabled: true,
      canonical: "abc123",
      tag: [{ tag: "realtime" }, { tag: "chat" }],
    });
  });

  it("maps every history scalar onto the message container tier", () => {
    expect(encodeRealtimeServer({ name: "s", history: false }).history).toEqual({
      inherit: false,
      message_enabled: false,
      message_limit: 100,
    });
    expect(encodeRealtimeServer({ name: "s", history: true }).history).toEqual({
      inherit: false,
      message_enabled: true,
      message_limit: 100,
    });
    expect(encodeRealtimeServer({ name: "s", history: 50 }).history).toEqual({
      inherit: false,
      message_enabled: true,
      message_limit: 50,
    });
    expect(encodeRealtimeServer({ name: "s", history: "all" }).history).toEqual({
      inherit: false,
      message_enabled: true,
      message_limit: -1,
    });
  });

  describe("getCanonical", () => {
    it("prefers an explicit override, then the def's own value", () => {
      const s = realtimeServer({ name: "chat", canonical: "in-code" });
      expect(s.getCanonical()).toBe("in-code");
      expect(s.getCanonical({ canonical: "override" })).toBe("override");
    });

    it("falls back to the value frozen in the lock", () => {
      seedLockOverrides({
        version: 1,
        objects: { "realtime_server:chat": { canonical: "locked-token" } },
      });
      expect(realtimeServer({ name: "chat" }).getCanonical()).toBe("locked-token");
    });

    it("throws with the export --lock fix when nothing resolves", () => {
      expect(() => realtimeServer({ name: "chat" }).getCanonical()).toThrow(
        /sidestep export --lock/,
      );
    });
  });

  it("keeps the accessor off the encoded payload", () => {
    const s = realtimeServer({ name: "chat", canonical: "abc" });
    expect(encodeRealtimeServer(s)).not.toHaveProperty("getCanonical");
    expect(JSON.parse(JSON.stringify(s))).not.toHaveProperty("getCanonical");
  });
});
