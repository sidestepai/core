/**
 * The realtime family's ENVELOPE CONTRACT — the stored field set the engine
 * declares for each of the three realtime objects, pinned as data.
 *
 * The per-kind tests (`realtime-server.test.ts`, `realtime-channel.test.ts`,
 * `realtime-message.test.ts`) already assert each encoder's full output with a
 * literal `toEqual`, which catches a field SideStep adds, renames, or drops.
 * What they do not do is say where that literal came from — so a reader cannot
 * tell an engine-mandated key from an incidental one, and an engine that grows a
 * field has no place in the suite to be recorded.
 *
 * This file is that place. Each set below mirrors the field list the engine
 * declares for the object's stored config, so re-verifying the contract is a
 * diff against one array rather than an archaeology exercise across three files.
 *
 * Three fields are deliberately absent from every set: `guid`, `workspace`, and
 * `branch`. The engine stores all three, but the bundle assembly layer stamps
 * them (see `Xano.register`) rather than the per-kind encoders, so their absence
 * from an encoder's output is correct and not drift.
 *
 * The history block differs by tier and it is easy to get backwards:
 *  - server and channel are CONTAINER tiers -> `message_enabled`/`message_limit`
 *  - message is the OBJECT tier -> plain `enabled`/`limit`
 * All three default OFF, unlike the query and tool container tiers, because
 * message history is a hot path.
 */
import { describe, it, expect } from "vitest";
import { encodeRealtimeServer } from "../../src/kinds/realtime-server.js";
import { encodeRealtimeChannel } from "../../src/kinds/realtime-channel.js";
import { encodeRealtimeMessage } from "../../src/kinds/realtime-message.js";
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { realtimeChannel } from "../../src/kinds/realtime-channel.js";

const chat = realtimeServer({ name: "chat" });
const rooms = realtimeChannel({ name: "rooms/{room_id}", server: chat });

/** Stored fields the engine declares for a realtime server. */
const SERVER_FIELDS = ["name", "description", "canonical", "enabled", "history", "tag"] as const;

/** Stored fields the engine declares for a channel. */
const CHANNEL_FIELDS = [
  "name",
  "description",
  "active",
  "server",
  "input",
  "anonymous_clients",
  "presence",
  "publish",
  "conversation",
  "delivery",
  "rate_limit",
  "history",
  "tag",
] as const;

/** Stored fields the engine declares for a message. */
const MESSAGE_FIELDS = [
  "name",
  "description",
  "active",
  "channel",
  "server",
  "auth",
  "deliver_to",
  "input",
  "output",
  "middleware",
  "run",
  "result",
  "history",
  "disabled",
  "tag",
] as const;

describe("realtime envelope contract", () => {
  it("a realtime server emits exactly the engine's declared field set", () => {
    expect(Object.keys(encodeRealtimeServer({ name: "chat" })).sort()).toEqual(
      [...SERVER_FIELDS].sort(),
    );
  });

  it("a channel emits exactly the engine's declared field set", () => {
    expect(Object.keys(encodeRealtimeChannel({ name: "rooms", server: chat })).sort()).toEqual(
      [...CHANNEL_FIELDS].sort(),
    );
  });

  it("a message emits exactly the engine's declared field set", () => {
    expect(Object.keys(encodeRealtimeMessage({ name: "send", channel: rooms })).sort()).toEqual(
      [...MESSAGE_FIELDS].sort(),
    );
  });

  it("keeps the container tiers on `message_*` history keys and the object tier on plain ones", () => {
    // Getting this backwards is silent: both shapes are valid JSON and both
    // carry an `inherit` flag, so only the key names distinguish them.
    expect(Object.keys(encodeRealtimeServer({ name: "s" }).history).sort()).toEqual([
      "inherit",
      "message_enabled",
      "message_limit",
    ]);
    expect(Object.keys(encodeRealtimeChannel({ name: "c", server: chat }).history).sort()).toEqual([
      "inherit",
      "message_enabled",
      "message_limit",
    ]);
    expect(
      Object.keys(encodeRealtimeMessage({ name: "m", channel: rooms }).history).sort(),
    ).toEqual(["enabled", "inherit", "limit"]);
  });

  it("defaults every realtime history tier OFF while inheriting", () => {
    // The realtime tier is the exception to "container history defaults ON":
    // query and tool containers default on, message defaults off.
    expect(encodeRealtimeServer({ name: "s" }).history).toEqual({
      inherit: true,
      message_enabled: false,
      message_limit: 100,
    });
    expect(encodeRealtimeChannel({ name: "c", server: chat }).history).toEqual({
      inherit: true,
      message_enabled: false,
      message_limit: 100,
    });
    expect(encodeRealtimeMessage({ name: "m", channel: rooms }).history).toEqual({
      inherit: true,
      enabled: false,
      limit: 100,
    });
  });

  it("emits every cross-object reference as a GUID, never a raw id", () => {
    // The archive importer resolves these guid-to-id against the destination
    // workspace. A raw integer would survive import as a dangling pointer into
    // the SOURCE workspace — the failure mode that is invisible until something
    // reads the wrong row.
    const channel = encodeRealtimeChannel({ name: "rooms", server: chat });
    expect(typeof channel.server.id).toBe("string");
    expect(channel.server.id).toMatch(/^[0-9a-f]{32}$/);

    const message = encodeRealtimeMessage({ name: "send", channel: rooms });
    expect(typeof message.channel.id).toBe("string");
    expect(message.channel.id).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof message.server.id).toBe("string");
    expect(message.server.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("resolves a message's channel and server independently, not as one reference", () => {
    // A channel path is unique only WITHIN a server, so the importer resolves
    // both FKs. Two servers owning the same path must produce two distinct
    // channel guids, or the pair collapses onto one row.
    const other = realtimeServer({ name: "support" });
    const roomsHere = realtimeChannel({ name: "rooms/{room_id}", server: chat });
    const roomsThere = realtimeChannel({ name: "rooms/{room_id}", server: other });

    const a = encodeRealtimeMessage({ name: "send", channel: roomsHere });
    const b = encodeRealtimeMessage({ name: "send", channel: roomsThere });

    expect(a.channel.id).not.toBe(b.channel.id);
    expect(a.server.id).not.toBe(b.server.id);
  });
});
