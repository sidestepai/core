/**
 * Realtime decoder fidelity beyond what the whole-workspace round trip proves.
 *
 * Round-tripping cannot see elision (a key elided and a key re-emitted at its
 * default both round-trip), and it cannot see whether a parent guid came back as
 * a readable handle reference or a raw 32-char string. Both are the readability
 * claim the realtime decoders make, so both are asserted against generated text.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import type { GeneratedProject } from "../../src/codegen/index.js";
import { Xano } from "../../src/workspace/xano.js";
import "../../src/index.js"; // register kinds
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { realtimeChannel } from "../../src/kinds/realtime-channel.js";
import { realtimeMessage } from "../../src/kinds/realtime-message.js";
import { realtimeServerTrigger, channelTrigger } from "../../src/kinds/trigger.js";
import sandbox from "../../examples/sandbox/index.js";

const chat = realtimeServer({ name: "chat", enabled: true });
const bare = realtimeChannel({ name: "lobby", server: chat });
const rich = realtimeChannel({
  name: "rooms/{room_id}",
  server: chat,
  publish: { who: "authenticated" },
  conversation: { enabled: true, limit: 50 },
  delivery: { perRecipient: true },
  rateLimit: { messagesPerMinute: 120 },
  history: 25,
});

function projectOf(build: (x: Xano) => Xano): GeneratedProject {
  return decodeBundle(build(new Xano()).export());
}

function sourceOf(project: GeneratedProject, symbol: string): string {
  const file = project.files.find((f) => f.contents.includes(`export const ${symbol} =`));
  expect(file, `no generated file exports ${symbol}`).toBeDefined();
  return file!.contents;
}

describe("realtime decoders — elision", () => {
  let project: GeneratedProject;

  beforeAll(() => {
    project = projectOf((x) =>
      x
        .registerRealtimeServers([chat])
        .registerRealtimeChannels([bare, rich])
        .registerRealtimeMessages([realtimeMessage({ name: "send", channel: bare })]),
    );
  });

  it("elides an all-default nested block as a whole", () => {
    const source = sourceOf(project, "lobby");
    // A channel that authored nothing must not carry the engine's skeleton.
    for (const key of ["publish:", "conversation:", "delivery:", "rateLimit:", "presence:"]) {
      expect(source, `${key} should be elided at its default`).not.toContain(key);
    }
  });

  it("emits only the customized members of a block the author did touch", () => {
    const source = sourceOf(project, "rooms_room_id");
    expect(source).toContain("publish:");
    expect(source).toContain('who: "authenticated"');
    // `direct` was never authored — emitting it would be exactly the noise
    // whole-block elision exists to prevent.
    expect(source).not.toContain("direct:");
    expect(source).toContain("perRecipient: true");
    // `guarantee` stayed at its default inside a block that was customized.
    expect(source).not.toContain("guarantee:");
  });

  it("renames stored snake_case members to their authoring names", () => {
    const source = sourceOf(project, "rooms_room_id");
    expect(source).toContain("messagesPerMinute: 120");
    expect(source).not.toContain("messages_per_minute");
    expect(source).not.toContain("per_recipient");
  });

  it("carries a customized container-history tier and elides the default one", () => {
    expect(sourceOf(project, "rooms_room_id")).toContain("history");
    // The realtime container tier defaults OFF; an untouched channel must not
    // come back carrying `history: false` as though the author had set it.
    expect(sourceOf(project, "lobby")).not.toContain("history");
  });

  it("elides `enabled` on a server that is off, and keeps it on one that is on", () => {
    expect(sourceOf(project, "chat")).toContain("enabled: true");
    const off = projectOf((x) => x.registerRealtimeServers([realtimeServer({ name: "quiet" })]));
    expect(sourceOf(off, "quiet")).not.toContain("enabled:");
  });
});

describe("realtime decoders — parent references", () => {
  it("resolves a channel's server guid back to the server handle", () => {
    const project = projectOf((x) =>
      x.registerRealtimeServers([chat]).registerRealtimeChannels([bare]),
    );
    const source = sourceOf(project, "lobby");
    expect(source).toContain("server: chat");
    expect(source).not.toMatch(/server: "[0-9a-f]{32}"/);
  });

  it("emits both the channel and the server on a decoded message", () => {
    // A decoded message has two guids and no way to know they agree, so it
    // states both rather than inferring the server from the channel handle.
    const project = projectOf((x) =>
      x
        .registerRealtimeServers([chat])
        .registerRealtimeChannels([bare])
        .registerRealtimeMessages([realtimeMessage({ name: "send", channel: bare })]),
    );
    const source = sourceOf(project, "send");
    expect(source).toContain("channel: lobby");
    expect(source).toContain("server: chat");
  });

  it("keeps a same-named message on two channels distinct in the generated tree", () => {
    const other = realtimeChannel({ name: "rooms", server: chat });
    const project = projectOf((x) =>
      x
        .registerRealtimeServers([chat])
        .registerRealtimeChannels([bare, other])
        .registerRealtimeMessages([
          realtimeMessage({ name: "send", channel: bare }),
          realtimeMessage({ name: "send", channel: other }),
        ]),
    );
    const messages = project.files.filter((f) => f.path.includes("realtimeMessages/"));
    expect(messages.length).toBe(2);
    const guids = messages.map((f) => /guid: "([0-9a-f]{32})"/.exec(f.contents)?.[1]);
    expect(guids[0]).not.toBe(guids[1]);
  });
});

describe("realtime lifecycle triggers — decode", () => {
  it("round-trips both new trigger types through the generic trigger decoder", () => {
    const project = projectOf((x) =>
      x
        .registerRealtimeServers([chat])
        .registerRealtimeChannels([rich])
        .registerTriggers([
          realtimeServerTrigger({
            name: "on_connect",
            realtimeServer: chat,
            actions: { connect: true },
          }),
          channelTrigger({ name: "on_join", channel: rich, actions: { join: true } }),
        ]),
    );
    const connect = sourceOf(project, "on_connect");
    expect(connect).toContain('objType: "realtime_server"');
    expect(connect).toContain("connect: true");
    const join = sourceOf(project, "on_join");
    expect(join).toContain('objType: "channel"');
    expect(join).toContain("join: true");
  });
});

describe("realtime decoders — sandbox coverage", () => {
  it("emits every realtime object and registers each on the barrel", () => {
    const project = decodeBundle(sandbox.export());
    const barrel = project.files.find((f) => f.path === "index.ts")!.contents;
    expect(barrel).toContain(".registerRealtimeServers([");
    expect(barrel).toContain(".registerRealtimeChannels([");
    expect(barrel).toContain(".registerRealtimeMessages([");

    // Assert on exported SYMBOLS, not on per-directory file counts: an object
    // referenced from more than one file is placed in `_shared.ts` by design, so
    // `ex_kind_chat_server` and the room channel (referenced by two messages and
    // a trigger) legitimately live there rather than under their kind directory.
    const all = project.files.map((f) => f.contents).join("\n");
    for (const symbol of [
      "ex_kind_chat_server",
      "lobby",
      "rooms_room_id",
      "send",
      "typing",
    ]) {
      expect(all, `${symbol} should be emitted somewhere in the tree`).toContain(
        `export const ${symbol} =`,
      );
    }
  });

  it("registers each kind in payload order even when a member lives in _shared.ts", () => {
    // Regression: the barrel used to register in PLACEMENT order, which groups by
    // file — so every `_shared.ts` member of a kind was registered ahead of the
    // members with their own file, reordering that payload section on re-export.
    // The room channel is shared and the lobby is not, and the lobby comes first
    // in the payload, so this ordering is exactly the case that used to flip.
    const source = sandbox.export();
    const project = decodeBundle(source);
    const barrel = project.files.find((f) => f.path === "index.ts")!.contents;
    const registration = /\.registerRealtimeChannels\(\[([^\]]*)\]\)/.exec(barrel)?.[1] ?? "";
    const registered = registration.split(",").map((s) => s.trim());
    const payloadNames = (source.payload.channel as Array<{ name: string }>).map((c) => c.name);
    expect(payloadNames).toEqual(["lobby", "rooms/{room_id}"]);
    expect(registered).toEqual(["lobby", "rooms_room_id"]);
  });

  it("places a multiply-referenced channel in _shared.ts rather than dropping it", () => {
    // The room channel is referenced by two messages and a channel trigger. A
    // regression here is silent: the object simply stops being emitted.
    const project = decodeBundle(sandbox.export());
    const shared = project.files.find((f) => f.path === "_shared.ts")!.contents;
    expect(shared).toContain("export const rooms_room_id =");
    expect(shared).toContain("export const ex_kind_chat_server =");
  });
});
