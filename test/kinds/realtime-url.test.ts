import { describe, it, expect, afterEach } from "vitest";
import {
  realtimeServer,
  realtimeChannel,
  encodeRealtimeServer,
  encodeRealtimeChannel,
  channelPathParams,
  input,
  seedLockOverrides,
  resetLockOverrides,
} from "../../src/index.js";

/**
 * `realtimeServer().getPath()`/`getUrl()` — the websocket connection URL,
 * `/ws/<canonical>` (with an optional `<tenant>:` prefix), derived from the
 * server `canonical` exactly as `mcpServer().getUrl()` derives its endpoint.
 * Plus `realtimeChannel().getChannel()`, which resolves the path a client puts
 * in a frame's `channel` field.
 */
describe("realtimeServer().getPath()/getUrl()", () => {
  afterEach(() => resetLockOverrides());

  it("builds /ws/<canonical> from an in-code canonical", () => {
    const s = realtimeServer({ name: "chat", canonical: "rtmain01" });
    expect(s.getPath()).toBe("/ws/rtmain01");
  });

  it("prefixes a tenant as <tenant>:<canonical>", () => {
    const s = realtimeServer({ name: "chat", canonical: "rtmain01" });
    expect(s.getPath({ tenant: "e8s0-b0cn-aba2" })).toBe("/ws/e8s0-b0cn-aba2:rtmain01");
  });

  it("rejects a tenant that would break the <tenant>:<canonical> split", () => {
    const s = realtimeServer({ name: "chat", canonical: "rtmain01" });
    expect(() => s.getPath({ tenant: "a:b" })).toThrow(/invalid `tenant`/);
    expect(() => s.getPath({ tenant: "a/b" })).toThrow(/invalid `tenant`/);
  });

  it("resolves the canonical frozen in xano.lock under `realtime_server:<name>`", () => {
    seedLockOverrides({ version: 1, objects: { "realtime_server:chat": { canonical: "Locked07" } } });
    expect(realtimeServer({ name: "chat" }).getPath()).toBe("/ws/Locked07");
  });

  it("an explicit getPath({ canonical }) override wins over def and lock", () => {
    seedLockOverrides({ version: 1, objects: { "realtime_server:chat": { canonical: "FromLock" } } });
    const s = realtimeServer({ name: "chat", canonical: "InCode1" });
    expect(s.getPath({ canonical: "Override" })).toBe("/ws/Override");
  });

  it("throws (never mints) when no canonical resolves", () => {
    expect(() => realtimeServer({ name: "chat" }).getPath()).toThrow(/sidestep export --lock/);
  });

  it("normalizes an http(s) base URL to ws(s) and trims trailing slashes", () => {
    const s = realtimeServer({ name: "chat", canonical: "rtmain01" });
    expect(s.getUrl("https://xare-rvr8-mnnt.dev.xano.io")).toBe(
      "wss://xare-rvr8-mnnt.dev.xano.io/ws/rtmain01",
    );
    expect(s.getUrl("https://xare-rvr8-mnnt.dev.xano.io//")).toBe(
      "wss://xare-rvr8-mnnt.dev.xano.io/ws/rtmain01",
    );
    expect(s.getUrl("http://127.0.0.1:9502")).toBe("ws://127.0.0.1:9502/ws/rtmain01");
  });

  it("passes a ws(s) base through and assumes wss for a bare host", () => {
    const s = realtimeServer({ name: "chat", canonical: "rtmain01" });
    expect(s.getUrl("wss://x.dev.xano.io")).toBe("wss://x.dev.xano.io/ws/rtmain01");
    expect(s.getUrl("ws://127.0.0.1:9502")).toBe("ws://127.0.0.1:9502/ws/rtmain01");
    expect(s.getUrl("x.dev.xano.io")).toBe("wss://x.dev.xano.io/ws/rtmain01");
  });

  it("carries the tenant through getUrl", () => {
    const s = realtimeServer({ name: "chat", canonical: "rtmain01" });
    expect(s.getUrl("https://xare-rvr8-mnnt.dev.xano.io", { tenant: "e8s0-b0cn-aba2" })).toBe(
      "wss://xare-rvr8-mnnt.dev.xano.io/ws/e8s0-b0cn-aba2:rtmain01",
    );
  });

  it("throws on an empty base URL", () => {
    const s = realtimeServer({ name: "chat", canonical: "rtmain01" });
    expect(() => s.getUrl("   ")).toThrow(/needs a base URL/);
  });

  it("keeps the accessors off the encoded payload and out of JSON", () => {
    const s = realtimeServer({ name: "chat", canonical: "abc", enabled: true });
    expect(encodeRealtimeServer(s)).toEqual(encodeRealtimeServer({ name: "chat", canonical: "abc", enabled: true }));
    const round = JSON.parse(JSON.stringify(s));
    expect(round.getPath).toBeUndefined();
    expect(round.getUrl).toBeUndefined();
  });
});

describe("realtimeChannel().getChannel()", () => {
  const server = realtimeServer({ name: "chat", canonical: "rtmain01" });

  it("returns a static path verbatim", () => {
    expect(realtimeChannel({ name: "lobby", server }).getChannel()).toBe("lobby");
  });

  it("fills {param} segments, coercing numbers", () => {
    const room = realtimeChannel({ name: "rooms/{room_id}", server, input: { room_id: input.int() } });
    expect(room.getChannel({ room_id: 42 })).toBe("rooms/42");
    expect(room.getChannel({ room_id: "vip" })).toBe("rooms/vip");
  });

  it("fills several params, in any argument order", () => {
    const c = realtimeChannel({
      name: "org/{org_id}/room/{room_id}",
      server,
      input: { org_id: input.int(), room_id: input.int() },
    });
    expect(c.getChannel({ room_id: 3, org_id: 7 })).toBe("org/7/room/3");
  });

  it("throws on a missing or empty param", () => {
    const room = realtimeChannel({ name: "rooms/{room_id}", server, input: { room_id: input.int() } });
    // @ts-expect-error — a parameterized path requires its params at the type level too
    expect(() => room.getChannel()).toThrow(/needs a value for the path param `room_id`/);
    expect(() => room.getChannel({ room_id: "" })).toThrow(/needs a value for the path param `room_id`/);
  });

  it("throws on an unknown param — a silent no-op would join the wrong channel", () => {
    const room = realtimeChannel({ name: "rooms/{room_id}", server, input: { room_id: input.int() } });
    expect(() =>
      room.getChannel({ room_id: 1, roomId: 2 } as unknown as { room_id: number }),
    ).toThrow(/not a {param} segment/);
    expect(() =>
      realtimeChannel({ name: "lobby", server }).getChannel({ x: 1 } as unknown as Record<string, never>),
    ).toThrow(/path is static/);
  });

  it("throws on a param value containing a slash", () => {
    const room = realtimeChannel({ name: "rooms/{room_id}", server, input: { room_id: input.int() } });
    expect(() => room.getChannel({ room_id: "42/admin" })).toThrow(/cannot contain "\/"/);
  });

  it("throws when a {param} segment has no input to bind it to", () => {
    expect(() => realtimeChannel({ name: "rooms/{room_id}", server })).toThrow(
      /no `room_id` input/,
    );
  });

  it("keeps the accessor off the encoded payload and out of JSON", () => {
    const bare = { name: "rooms/{room_id}", server, presence: true, input: { room_id: input.int() } };
    const room = realtimeChannel(bare);
    expect(encodeRealtimeChannel(room)).toEqual(encodeRealtimeChannel(bare));
    expect(JSON.parse(JSON.stringify(room)).getChannel).toBeUndefined();
  });

  it("channelPathParams lists the {param} segments in order", () => {
    expect(channelPathParams("lobby")).toEqual([]);
    expect(channelPathParams("org/{org_id}/room/{room_id}")).toEqual(["org_id", "room_id"]);
  });
});
