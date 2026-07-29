import { describe, it, expect } from "vitest";
import {
  realtimeMessage,
  encodeRealtimeMessage,
  realtimeMessageGuid,
} from "../../src/kinds/realtime-message.js";
import { realtimeChannel, realtimeChannelGuid } from "../../src/kinds/realtime-channel.js";
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { deriveGuid, realtimeMessageSeedName } from "../../src/refs/guid.js";
import { encodeQuery } from "../../src/kinds/query.js";
import { input } from "../../src/inputs/input.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { s } from "../../src/statements/s.js";
import { c } from "../../src/values/value.js";
import { middleware } from "../../src/kinds/middleware.js";

const chat = realtimeServer({ name: "chat" });
const rooms = realtimeChannel({
  name: "rooms/{room_id}",
  server: chat,
  input: { room_id: input.int() },
});

describe("realtimeMessage", () => {
  it("encodes a minimal def to the full stored envelope", () => {
    expect(encodeRealtimeMessage({ name: "send", channel: rooms })).toEqual({
      name: "send",
      description: "",
      active: true,
      channel: { id: realtimeChannelGuid(rooms) },
      server: { id: deriveGuid("realtime_server", "chat") },
      auth: false,
      deliver_to: "channel",
      input: [],
      output: [],
      middleware: { pre_customize: false, post_customize: false, pre: [], post: [] },
      run: [],
      result: [],
      // Message history is a hot path — off, not on, at the object tier too.
      history: { inherit: true, enabled: false, limit: 100 },
      disabled: false,
      tag: [],
    });
  });

  it("requires a name", () => {
    expect(() => encodeRealtimeMessage({ name: "", channel: rooms })).toThrow(
      /`name` is required/,
    );
  });

  describe("host resolution", () => {
    it("takes the server from a channel handle without repeating it", () => {
      const m = encodeRealtimeMessage({ name: "send", channel: rooms });
      expect(m.server).toEqual({ id: deriveGuid("realtime_server", "chat") });
      expect(m.channel).toEqual({ id: realtimeChannelGuid(rooms) });
    });

    it("throws on a bare channel path with no server", () => {
      expect(() =>
        encodeRealtimeMessage({ name: "send", channel: "rooms/{room_id}" }),
      ).toThrow(/`server` is required when `channel` is a bare path/);
    });

    it("resolves a bare channel path when a server is supplied", () => {
      const byPath = encodeRealtimeMessage({
        name: "send",
        channel: "rooms/{room_id}",
        server: "chat",
      });
      expect(byPath.channel).toEqual({ id: realtimeChannelGuid(rooms) });
      expect(byPath.server).toEqual({ id: deriveGuid("realtime_server", "chat") });
    });

    it("rejects a server that contradicts the channel handle", () => {
      expect(() =>
        encodeRealtimeMessage({ name: "send", channel: rooms, server: "auction" }),
      ).toThrow(/but the channel handle belongs to "chat"/);
    });

    it("accepts a redundant server that agrees with the handle", () => {
      expect(() =>
        encodeRealtimeMessage({ name: "send", channel: rooms, server: "chat" }),
      ).not.toThrow();
    });

    it("requires a channel", () => {
      expect(() => encodeRealtimeMessage({ name: "send" } as never)).toThrow(
        /`channel` is required/,
      );
    });
  });

  describe("identity", () => {
    it("composes the guid from server, channel path, and name", () => {
      expect(realtimeMessageGuid({ name: "send", channel: rooms })).toBe(
        deriveGuid("message", realtimeMessageSeedName("chat", "rooms/{room_id}", "send")),
      );
    });

    it("gives the same name on two channels two different guids", () => {
      const lobby = realtimeChannel({ name: "lobby", server: chat });
      expect(realtimeMessageGuid({ name: "send", channel: rooms })).not.toBe(
        realtimeMessageGuid({ name: "send", channel: lobby }),
      );
    });

    it("uses an explicit guid verbatim", () => {
      expect(realtimeMessageGuid({ name: "send", channel: rooms, guid: "pinned" })).toBe(
        "pinned",
      );
    });
  });

  it("encodes the payload input map", () => {
    const m = encodeRealtimeMessage({
      name: "place_bid",
      channel: rooms,
      input: { amount: input.int() },
    });
    expect(m.input).toHaveLength(1);
    expect(m.input[0]).toMatchObject({ name: "amount", type: "int" });
  });

  it("resolves auth from an auth table handle, and false when omitted", () => {
    const users = table({ name: "users", auth: true, schema: { email: f.text() } });
    const withAuth = encodeRealtimeMessage({ name: "send", channel: rooms, auth: users });
    expect(withAuth.auth).toBe(deriveGuid("dbo", "users"));
    expect(encodeRealtimeMessage({ name: "send", channel: rooms, auth: false }).auth).toBe(false);
    expect(encodeRealtimeMessage({ name: "send", channel: rooms }).auth).toBe(false);
  });

  it("round-trips every deliver_to value", () => {
    for (const deliverTo of ["channel", "sender", "others", "explicit"] as const) {
      expect(
        encodeRealtimeMessage({ name: "send", channel: rooms, deliverTo }).deliver_to,
      ).toBe(deliverTo);
    }
  });

  it("sets the customize flag on an attached middleware phase", () => {
    const audit = middleware({ name: "audit", stack: [] });
    const m = encodeRealtimeMessage({
      name: "send",
      channel: rooms,
      middleware: { pre: [audit] },
    });
    expect(m.middleware.pre_customize).toBe(true);
    expect(m.middleware.pre).toHaveLength(1);
    expect(m.middleware.post_customize).toBe(false);
  });

  it("encodes a response into result[]", () => {
    const m = encodeRealtimeMessage({
      name: "send",
      channel: rooms,
      stack: [s.set_var("ok", c.int(1))],
      response: c.int(1),
    });
    expect(m.result.length).toBeGreaterThan(0);
  });

  it("maps history scalars onto the object tier", () => {
    expect(encodeRealtimeMessage({ name: "m", channel: rooms, history: true }).history).toEqual({
      inherit: false,
      enabled: true,
      limit: 100,
    });
    expect(encodeRealtimeMessage({ name: "m", channel: rooms, history: "all" }).history).toEqual({
      inherit: false,
      enabled: true,
      limit: -1,
    });
  });

  it("encodes a stack byte-identically to the same stack on a query", () => {
    const stack = [s.set_var("greeting", c.text("hi")), s.set_var("shout", c.text("YO"))];
    const asMessage = encodeRealtimeMessage({ name: "send", channel: rooms, stack });
    const asQuery = encodeQuery({ name: "send", verb: "POST", stack });
    expect(asMessage.run).toEqual(asQuery.run);
  });

  it("preserves the typed input map through the factory", () => {
    const m = realtimeMessage({
      name: "place_bid",
      channel: rooms,
      input: { amount: input.int() },
    });
    expect(Object.keys(m.input!)).toEqual(["amount"]);
  });
});
