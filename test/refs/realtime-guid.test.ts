import { describe, it, expect } from "vitest";
import {
  deriveGuid,
  realtimeChannelSeedName,
  realtimeMessageSeedName,
  REFERENCEABLE_KIND_PAYLOAD_KEYS,
} from "../../src/refs/guid.js";

/**
 * Realtime names are NOT workspace-unique: a channel path is unique only per
 * server, and a message name only per channel. The plain `md5(type:name)`
 * formula every other kind uses would therefore derive one guid for two
 * distinct objects — and the engine upserts by guid, so the second would
 * overwrite the first. These tests pin the composite seeds that prevent it.
 */
describe("realtime identity seeds", () => {
  it("registers the three realtime kinds against their engine payload keys", () => {
    expect(REFERENCEABLE_KIND_PAYLOAD_KEYS.realtime_server).toBe("realtime_server");
    expect(REFERENCEABLE_KIND_PAYLOAD_KEYS.channel).toBe("channel");
    expect(REFERENCEABLE_KIND_PAYLOAD_KEYS.message).toBe("message");
  });

  it("derives a realtime server guid from the plain type:name seed", () => {
    const g = deriveGuid("realtime_server", "chat");
    expect(g).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveGuid("realtime_server", "chat")).toBe(g);
    expect(deriveGuid("realtime_server", "auction")).not.toBe(g);
  });

  it("gives the same channel path under two servers two different guids", () => {
    const a = deriveGuid("channel", realtimeChannelSeedName("chat", "rooms"));
    const b = deriveGuid("channel", realtimeChannelSeedName("auction", "rooms"));
    expect(a).not.toBe(b);
  });

  it("gives the same channel path under the same server one stable guid", () => {
    const a = deriveGuid("channel", realtimeChannelSeedName("chat", "rooms/{room_id}"));
    const b = deriveGuid("channel", realtimeChannelSeedName("chat", "rooms/{room_id}"));
    expect(a).toBe(b);
  });

  it("gives the same message name on two channels two different guids", () => {
    const a = deriveGuid("message", realtimeMessageSeedName("chat", "rooms", "send"));
    const b = deriveGuid("message", realtimeMessageSeedName("chat", "lobby", "send"));
    expect(a).not.toBe(b);
  });

  it("gives the same message name under two servers two different guids", () => {
    const a = deriveGuid("message", realtimeMessageSeedName("chat", "rooms", "send"));
    const b = deriveGuid("message", realtimeMessageSeedName("auction", "rooms", "send"));
    expect(a).not.toBe(b);
  });

  it("keeps a server/path split unambiguous — 'a/b' + 'c' never equals 'a' + 'b/c'", () => {
    expect(realtimeChannelSeedName("a/b", "c")).not.toBe(realtimeChannelSeedName("a", "b/c"));
  });

  it("rejects a server name carrying the seed separator", () => {
    expect(() => realtimeChannelSeedName("a|b", "rooms")).toThrow(/\|/);
    expect(() => realtimeMessageSeedName("a|b", "rooms", "send")).toThrow(/\|/);
  });

  it("requires every seed component", () => {
    expect(() => realtimeChannelSeedName("", "rooms")).toThrow(/server/);
    expect(() => realtimeChannelSeedName("chat", "")).toThrow(/path/);
    expect(() => realtimeMessageSeedName("chat", "rooms", "")).toThrow(/name/);
  });
});
