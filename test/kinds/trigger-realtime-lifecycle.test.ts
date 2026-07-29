import { describe, it, expect } from "vitest";
import {
  realtimeServerTrigger,
  realtimeChannelTrigger,
  realtimeTrigger,
  encodeTrigger,
} from "../../src/kinds/trigger.js";
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { realtimeChannel, realtimeChannelGuid } from "../../src/kinds/realtime-channel.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { s } from "../../src/statements/s.js";
import { c } from "../../src/values/value.js";
import { input } from "../../src/inputs/input.js";

const chat = realtimeServer({ name: "chat" });
const rooms = realtimeChannel({ name: "rooms/{room_id}", server: chat, input: { room_id: input.int() } });

describe("realtimeServerTrigger", () => {
  it("encodes its own obj_type, action meta, and implied inputs", () => {
    const t = encodeTrigger(
      realtimeServerTrigger({ name: "on_connect", realtimeServer: chat, actions: { connect: true } }),
    );
    expect(t.obj_type).toBe("realtime_server");
    expect(t.meta).toEqual({
      realtime_server: { action: { connect: true, disconnect: false } },
    });
    expect(t.input.map((i) => i.name)).toEqual(["action", "realtime_server", "client"]);
    expect(t.result).toEqual([]);
  });

  it("carries the connect/disconnect action enum with no default", () => {
    const t = encodeTrigger(realtimeServerTrigger({ name: "t", realtimeServer: chat }));
    const action = t.input[0] as { type: string; values?: string[]; default?: unknown };
    expect(action.type).toBe("enum");
    expect(action.values).toEqual(["connect", "disconnect"]);
    // A defaultless enum stores `""` on the export surface — matching every
    // engine-captured trigger fixture (table/workspace `action`). Unlike the
    // legacy channel trigger, this one carries no `"message"`-style default.
    expect(action.default).toBe("");
  });

  it("encodes both actions off when none are given", () => {
    const t = encodeTrigger(realtimeServerTrigger({ name: "t", realtimeServer: chat }));
    expect(t.meta).toEqual({
      realtime_server: { action: { connect: false, disconnect: false } },
    });
  });

  it("binds the host by guid, from a handle or a bare name identically", () => {
    const expected = deriveGuid("realtime_server", "chat");
    expect(encodeTrigger(realtimeServerTrigger({ name: "t", realtimeServer: chat })).obj_id).toBe(
      expected,
    );
    expect(encodeTrigger(realtimeServerTrigger({ name: "t", realtimeServer: "chat" })).obj_id).toBe(
      expected,
    );
  });

  it("falls back to a raw objId when no host handle is given", () => {
    expect(encodeTrigger(realtimeServerTrigger({ name: "t", objId: 42 })).obj_id).toBe(42);
  });

  it("exposes typed inputs on the stack handle", () => {
    const def = realtimeServerTrigger({
      name: "t",
      realtimeServer: chat,
      stack: (h) => [s.set_var("who", h.client("permissions.row_id"))],
    });
    expect(def.stack).toHaveLength(1);
  });

  it("emits a response into result[] when one is given", () => {
    const t = encodeTrigger(
      realtimeServerTrigger({ name: "t", realtimeServer: chat, response: () => c.bool(true) }),
    );
    expect(t.result!.length).toBeGreaterThan(0);
  });
});

describe("realtimeChannelTrigger", () => {
  it("encodes its own obj_type, action meta, and implied inputs", () => {
    const t = encodeTrigger(
      realtimeChannelTrigger({ name: "on_join", channel: rooms, actions: { join: true, leave: true } }),
    );
    expect(t.obj_type).toBe("channel");
    expect(t.meta).toEqual({ channel: { action: { join: true, leave: true } } });
    expect(t.input.map((i) => i.name)).toEqual(["action", "channel", "client"]);
  });

  it("carries the join/leave action enum", () => {
    const t = encodeTrigger(realtimeChannelTrigger({ name: "t", channel: rooms }));
    const action = t.input[0] as { values?: string[] };
    expect(action.values).toEqual(["join", "leave"]);
  });

  it("binds the host to the channel's composite guid", () => {
    expect(encodeTrigger(realtimeChannelTrigger({ name: "t", channel: rooms })).obj_id).toBe(
      realtimeChannelGuid(rooms),
    );
  });

  it("binds a same-path channel on another server to a different host guid", () => {
    const other = realtimeChannel({
      name: "rooms/{room_id}",
      server: realtimeServer({ name: "auction" }),
      input: { room_id: input.int() },
    });
    expect(encodeTrigger(realtimeChannelTrigger({ name: "t", channel: rooms })).obj_id).not.toBe(
      encodeTrigger(realtimeChannelTrigger({ name: "t", channel: other })).obj_id,
    );
  });

  it("encodes both actions off when none are given", () => {
    expect(encodeTrigger(realtimeChannelTrigger({ name: "t", channel: rooms })).meta).toEqual({
      channel: { action: { join: false, leave: false } },
    });
  });
});

describe("legacy realtime trigger (regression guard)", () => {
  it("keeps its own obj_type, four-group meta skeleton, and inputs", () => {
    const t = encodeTrigger(realtimeTrigger({ name: "legacy", actions: { message: true } }));
    expect(t.obj_type).toBe("workspace_realtime_channel");
    expect(t.meta).toMatchObject({
      database: { action: { delete: false, insert: false, truncate: false, update: false } },
      toolset: { action: { connection: false } },
      workspace: { action: { branch_live: false, branch_merge: false, branch_new: false } },
      workspace_realtime_channel: { action: { message: true, join: false } },
    });
    expect(t.input.map((i) => i.name)).toEqual([
      "action",
      "channel",
      "client",
      "options",
      "payload",
    ]);
  });
});
