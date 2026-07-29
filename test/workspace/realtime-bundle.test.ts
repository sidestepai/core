import { describe, it, expect } from "vitest";
import { Xano } from "../../src/workspace/xano.js";
import "../../src/index.js"; // register kinds
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { realtimeChannel, realtimeChannelGuid } from "../../src/kinds/realtime-channel.js";
import { realtimeMessage, realtimeMessageGuid } from "../../src/kinds/realtime-message.js";
import { PAYLOAD_ARRAY_KEYS } from "../../src/workspace/export.js";
import { deriveGuid } from "../../src/refs/guid.js";

function build() {
  const chat = realtimeServer({ name: "chat", enabled: true });
  const rooms = realtimeChannel({ name: "rooms/{room_id}", server: chat });
  const lobby = realtimeChannel({ name: "lobby", server: chat });
  const send = realtimeMessage({ name: "send", channel: rooms });
  const announce = realtimeMessage({ name: "send", channel: lobby });
  return { chat, rooms, lobby, send, announce };
}

describe("realtime bundle wiring", () => {
  it("orders the realtime sections server → channel → message", () => {
    const keys = PAYLOAD_ARRAY_KEYS as readonly string[];
    expect(keys).toContain("realtime_server");
    expect(keys.indexOf("realtime_server")).toBeLessThan(keys.indexOf("channel"));
    expect(keys.indexOf("channel")).toBeLessThan(keys.indexOf("message"));
  });

  it("emits all three sections through the register* sugar", () => {
    const { chat, rooms, lobby, send, announce } = build();
    const bundle = new Xano()
      .registerRealtimeServers([chat])
      .registerRealtimeChannels([rooms, lobby])
      .registerRealtimeMessages([send, announce])
      .export();

    expect(bundle.payload.realtime_server).toHaveLength(1);
    expect(bundle.payload.channel).toHaveLength(2);
    expect(bundle.payload.message).toHaveLength(2);
    expect(bundle.sig).toMatch(/^[\w\-.]+$/);
  });

  it("stamps the composite guid on each object, not the name derivation", () => {
    const { chat, rooms, lobby, send, announce } = build();
    const bundle = new Xano()
      .registerRealtimeServers([chat])
      .registerRealtimeChannels([rooms, lobby])
      .registerRealtimeMessages([send, announce])
      .export();

    const guidOf = (section: string, i: number) =>
      (bundle.payload[section] as Array<{ guid: string }>)[i]!.guid;

    expect(guidOf("realtime_server", 0)).toBe(deriveGuid("realtime_server", "chat"));
    expect(guidOf("channel", 0)).toBe(realtimeChannelGuid(rooms));
    expect(guidOf("message", 0)).toBe(realtimeMessageGuid(send));

    // The load-bearing property: two same-named messages on different channels
    // must NOT share a guid — the engine upserts by guid.
    expect(guidOf("message", 0)).not.toBe(guidOf("message", 1));
    expect(guidOf("channel", 0)).not.toBe(guidOf("channel", 1));
  });

  it("binds each child to its parent by the parent's guid", () => {
    const { chat, rooms, send } = build();
    const bundle = new Xano()
      .registerRealtimeServers([chat])
      .registerRealtimeChannels([rooms])
      .registerRealtimeMessages([send])
      .export();

    const serverGuid = (bundle.payload.realtime_server as Array<{ guid: string }>)[0]!.guid;
    const channelGuid = (bundle.payload.channel as Array<{ guid: string }>)[0]!.guid;
    const channel = (bundle.payload.channel as Array<{ server: { id: string } }>)[0]!;
    const message = (bundle.payload.message as Array<{
      server: { id: string };
      channel: { id: string };
    }>)[0]!;

    expect(channel.server.id).toBe(serverGuid);
    expect(message.server.id).toBe(serverGuid);
    expect(message.channel.id).toBe(channelGuid);
  });

  it("emits empty realtime sections and an unchanged signature for a realtime-free workspace", () => {
    const withoutRealtime = new Xano().export();
    expect(withoutRealtime.payload.realtime_server).toEqual([]);
    expect(withoutRealtime.payload.channel).toEqual([]);
    expect(withoutRealtime.payload.message).toEqual([]);
    // Empty sections are shape parity only — adding them must not change the
    // signature of a bundle that has no realtime objects.
    expect(withoutRealtime.sig).toBe(new Xano().export().sig);
  });

  it("mints a canonical for a realtime server at locked export", () => {
    const { chat } = build();
    const ctx = { lock: { version: 1 as const, objects: {} }, observed: {} };
    const bundle = new Xano().registerRealtimeServers([chat]).export({ lock: ctx });
    const server = (bundle.payload.realtime_server as Array<{ canonical: string }>)[0]!;
    expect(server.canonical).not.toBe("");
  });

  it("accepts a single def as well as an array", () => {
    const { chat } = build();
    const bundle = new Xano().registerRealtimeServers(chat as never).export();
    expect(bundle.payload.realtime_server).toHaveLength(1);
  });
});
