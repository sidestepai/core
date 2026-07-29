import { describe, it, expect } from "vitest";
import {
  realtimeChannel,
  encodeRealtimeChannel,
  realtimeChannelGuid,
} from "../../src/kinds/realtime-channel.js";
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { deriveGuid, realtimeChannelSeedName } from "../../src/refs/guid.js";
import { input } from "../../src/inputs/input.js";

const chat = realtimeServer({ name: "chat" });

describe("realtimeChannel", () => {
  it("encodes a minimal def with every nested block at its engine default", () => {
    expect(encodeRealtimeChannel({ name: "rooms", server: chat })).toEqual({
      name: "rooms",
      description: "",
      active: true,
      server: { id: deriveGuid("realtime_server", "chat") },
      input: [],
      anonymous_clients: false,
      presence: false,
      publish: { who: "nobody", direct: false },
      conversation: { enabled: false, limit: 0, ttl: 0 },
      delivery: { guarantee: "at_most_once", per_recipient: false },
      rate_limit: { messages_per_minute: 0 },
      history: { inherit: true, message_enabled: false, message_limit: 100 },
      tag: [],
    });
  });

  it("fills the untouched sibling of a partially-specified nested block", () => {
    const c = encodeRealtimeChannel({
      name: "rooms",
      server: chat,
      publish: { who: "authenticated" },
      conversation: { enabled: true },
      delivery: { perRecipient: true },
    });
    expect(c.publish).toEqual({ who: "authenticated", direct: false });
    expect(c.conversation).toEqual({ enabled: true, limit: 0, ttl: 0 });
    expect(c.delivery).toEqual({ guarantee: "at_most_once", per_recipient: true });
  });

  it("encodes every authored option", () => {
    const c = encodeRealtimeChannel({
      name: "rooms/{room_id}",
      server: chat,
      input: { room_id: input.int() },
      description: "one channel per room",
      active: false,
      anonymousClients: true,
      presence: true,
      publish: { who: "anyone", direct: true },
      conversation: { enabled: true, limit: 50, ttl: 3600 },
      delivery: { guarantee: "at_least_once", perRecipient: true },
      rateLimit: { messagesPerMinute: 120 },
      history: 25,
      tags: ["chat"],
    });
    expect(c).toMatchObject({
      name: "rooms/{room_id}",
      description: "one channel per room",
      active: false,
      anonymous_clients: true,
      presence: true,
      publish: { who: "anyone", direct: true },
      conversation: { enabled: true, limit: 50, ttl: 3600 },
      delivery: { guarantee: "at_least_once", per_recipient: true },
      rate_limit: { messages_per_minute: 120 },
      history: { inherit: false, message_enabled: true, message_limit: 25 },
      tag: [{ tag: "chat" }],
    });
  });

  it("encodes typed path parameters into the stored input array", () => {
    const c = encodeRealtimeChannel({
      name: "rooms/{room_id}",
      server: chat,
      input: { room_id: input.int() },
    });
    expect(c.input).toHaveLength(1);
    expect(c.input[0]).toMatchObject({ name: "room_id", type: "int" });
  });

  it("resolves the server given as a handle and as a bare name identically", () => {
    const byHandle = encodeRealtimeChannel({ name: "rooms", server: chat });
    const byName = encodeRealtimeChannel({ name: "rooms", server: "chat" });
    expect(byHandle.server).toEqual(byName.server);
  });

  it("prefers an explicit guid pinned on the server handle", () => {
    const pinned = realtimeServer({ name: "chat", guid: "deadbeef" });
    expect(encodeRealtimeChannel({ name: "rooms", server: pinned }).server).toEqual({
      id: "deadbeef",
    });
  });

  it("throws when the server is missing — a path alone is ambiguous", () => {
    expect(() =>
      encodeRealtimeChannel({ name: "rooms" } as never),
    ).toThrow(/`server` is required/);
  });

  it("requires a name", () => {
    expect(() => encodeRealtimeChannel({ name: "", server: chat })).toThrow(
      /`name` is required/,
    );
  });

  describe("identity", () => {
    it("composes the guid from the server and the path", () => {
      expect(realtimeChannelGuid({ name: "rooms", server: chat })).toBe(
        deriveGuid("channel", realtimeChannelSeedName("chat", "rooms")),
      );
    });

    it("gives the same path under two servers two different guids", () => {
      expect(realtimeChannelGuid({ name: "rooms", server: "chat" })).not.toBe(
        realtimeChannelGuid({ name: "rooms", server: "auction" }),
      );
    });

    it("uses an explicit guid verbatim", () => {
      expect(realtimeChannelGuid({ name: "rooms", server: chat, guid: "pinned" })).toBe(
        "pinned",
      );
    });
  });

  it("preserves the typed input map through the factory", () => {
    const c = realtimeChannel({
      name: "rooms/{room_id}",
      server: chat,
      input: { room_id: input.int() },
    });
    expect(Object.keys(c.input!)).toEqual(["room_id"]);
  });
});
