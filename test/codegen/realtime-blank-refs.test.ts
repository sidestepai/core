/**
 * Blank realtime references on the READ path.
 *
 * The engine's export-side reference remap degrades to `""` when the target sits
 * outside the export's scope — a schema-scoped export carries triggers but not
 * the realtime objects they point at — rather than aborting the whole export.
 * SideStep's own reads always include realtime objects, so its own bundles never
 * produce one; but nothing stops a user pulling from an archive produced by a
 * narrower export, and a required binding that vanishes silently there leaves a
 * def whose cause is upstream and invisible.
 *
 * So the contract asserted here is: the pull still completes (throwing would make
 * such an archive un-pullable, strictly worse), the binding is NOT emitted at a
 * blank or zero value, and the loss arrives as an error-severity report line.
 */
import { describe, it, expect } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import type { GeneratedProject } from "../../src/codegen/index.js";
import { Xano } from "../../src/workspace/xano.js";
import "../../src/index.js"; // register kinds
import { realtimeServer } from "../../src/kinds/realtime-server.js";
import { realtimeChannel } from "../../src/kinds/realtime-channel.js";
import { realtimeMessage } from "../../src/kinds/realtime-message.js";
import { realtimeServerTrigger, realtimeChannelTrigger } from "../../src/kinds/trigger.js";

const chat = realtimeServer({ name: "chat", enabled: true });
const lobby = realtimeChannel({ name: "lobby", server: chat });
const send = realtimeMessage({ name: "send", channel: lobby });

/** A healthy bundle carrying all three kinds plus both lifecycle triggers. */
function healthyBundle(): { payload: Record<string, unknown> } {
  return new Xano()
    .registerRealtimeServers([chat])
    .registerRealtimeChannels([lobby])
    .registerRealtimeMessages([send])
    .registerTriggers([
      realtimeServerTrigger({
        name: "on_connect",
        realtimeServer: chat,
        actions: { connect: true },
      }),
      realtimeChannelTrigger({ name: "on_join", channel: lobby, actions: { join: true } }),
    ])
    .export() as unknown as { payload: Record<string, unknown> };
}

/**
 * Decode a bundle after blanking one field, the way a narrower source export
 * would have left it. `mutate` receives the live payload.
 */
function decodeWith(mutate: (payload: Record<string, unknown>) => void): GeneratedProject {
  const bundle = healthyBundle();
  mutate(bundle.payload);
  return decodeBundle(bundle);
}

/** Every unresolved-ref detail line, joined for substring assertions. */
function unresolved(project: GeneratedProject): string[] {
  return project.report.entries.filter((e) => e.category === "unresolved-ref").map((e) => e.detail);
}

function sourceOf(project: GeneratedProject, symbol: string): string {
  const file = project.files.find((f) => f.contents.includes(`export const ${symbol} =`));
  expect(file, `no generated file exports ${symbol}`).toBeDefined();
  return file!.contents;
}

/** Read the single entry of a payload section. */
function only(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const section = payload[key] as Array<Record<string, unknown>>;
  expect(Array.isArray(section) && section.length > 0, `payload.${key} is empty`).toBe(true);
  return section[0]!;
}

describe("blank realtime references", () => {
  it("flags a channel whose server reference was blanked, and omits the binding", () => {
    const project = decodeWith((p) => {
      (only(p, "channel").server as { id: unknown }).id = "";
    });

    const details = unresolved(project);
    expect(details.some((d) => d.includes("`server`"))).toBe(true);
    // The cause distinguishes the two shapes: blank points UPSTREAM at the
    // export's scope, absent/0 points at the object itself.
    expect(details.some((d) => d.includes("blanked by the source export"))).toBe(true);

    // Whatever else happens, a blank must not reach the generated source as a
    // binding — `server: ""` would compile as a server NAMED empty string and
    // derive a guid for an object that does not exist.
    const source = sourceOf(project, "lobby");
    expect(source).not.toContain('server: ""');
  });

  it("flags an absent or zero server reference with the other cause", () => {
    const project = decodeWith((p) => {
      (only(p, "channel").server as { id: unknown }).id = 0;
    });

    const details = unresolved(project);
    expect(details.some((d) => d.includes("`server`"))).toBe(true);
    expect(details.some((d) => d.includes("absent or 0 in the source object"))).toBe(true);
  });

  it("flags a message half-resolved to its channel but missing its server", () => {
    // The encoder accepts a channel handle alone, but a DECODED message holds two
    // independent guids and cannot know they agree — so a half-resolved pair is a
    // real gap, not a shorthand.
    const project = decodeWith((p) => {
      (only(p, "message").server as { id: unknown }).id = "";
    });

    const details = unresolved(project);
    expect(details.some((d) => d.includes("`server`"))).toBe(true);
  });

  it("flags a message missing its channel reference", () => {
    const project = decodeWith((p) => {
      (only(p, "message").channel as { id: unknown }).id = "";
    });

    expect(unresolved(project).some((d) => d.includes("`channel`"))).toBe(true);
  });

  it("flags a blanked channel-trigger target instead of emitting an empty objId", () => {
    const project = decodeWith((p) => {
      const triggers = p.trigger as Array<Record<string, unknown>>;
      const channelTrigger = triggers.find((t) => t.obj_type === "channel")!;
      channelTrigger.obj_id = "";
    });

    expect(unresolved(project).some((d) => d.includes("`objId`"))).toBe(true);
    // `objId: ""` is the failure mode this replaces: it COMPILES (a raw objId is
    // the escape hatch, typed number | string) and then binds the trigger to
    // nothing — no compile error, no report line, no working trigger.
    const source = sourceOf(project, "on_join");
    expect(source).not.toContain('objId: ""');
  });

  it("flags a blanked realtime-server-trigger target the same way", () => {
    const project = decodeWith((p) => {
      const triggers = p.trigger as Array<Record<string, unknown>>;
      const serverTrigger = triggers.find((t) => t.obj_type === "realtime_server")!;
      serverTrigger.obj_id = "";
    });

    expect(unresolved(project).some((d) => d.includes("`objId`"))).toBe(true);
    expect(sourceOf(project, "on_connect")).not.toContain('objId: ""');
  });

  it("records the loss at error severity — the tree does not reproduce its source", () => {
    const project = decodeWith((p) => {
      (only(p, "channel").server as { id: unknown }).id = "";
    });
    expect(project.report.summarize().bySeverity.error).toBeGreaterThan(0);
  });

  it("still completes the decode rather than throwing", () => {
    // Throwing would make a narrower archive un-pullable, which is worse than a
    // pull that completes with the loss named. Mirrors the engine's own posture.
    const project = decodeWith((p) => {
      (only(p, "channel").server as { id: unknown }).id = "";
      (only(p, "message").channel as { id: unknown }).id = "";
      (only(p, "message").server as { id: unknown }).id = "";
    });
    expect(project.files.length).toBeGreaterThan(0);
  });

  it("says nothing at all about a fully-referencing bundle", () => {
    // The check is worthless if it becomes background noise on healthy pulls.
    const project = decodeBundle(healthyBundle());
    expect(unresolved(project)).toEqual([]);
  });
});
