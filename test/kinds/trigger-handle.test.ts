import { describe, it, expect } from "vitest";
import {
  buildTriggerHandle,
  type RealtimeInputs,
  type ToolsetInputs,
  type WorkspaceInputs,
  type ErrorInputs,
} from "../../src/kinds/trigger-handle.js";
import "../../src/index.js"; // register all statements
import { s } from "../../src/statements/s.js";
import { encodeStatement } from "../../src/statements/statement.js";

describe("trigger input handle — runtime shape (U2)", () => {
  it("realtime: exposes action/channel/client/options/payload as input values", () => {
    const t = buildTriggerHandle("workspace_realtime_channel") as unknown as RealtimeInputs;
    expect({ ...t.action }).toEqual({ value: "action", tag: "input", filters: [] });
    expect({ ...t.channel }).toEqual({ value: "channel", tag: "input", filters: [] });
    expect({ ...t.payload }).toEqual({ value: "payload", tag: "input", filters: [] });
  });

  it("nested accessor builds a dotted input path", () => {
    const t = buildTriggerHandle("workspace_realtime_channel") as unknown as RealtimeInputs;
    expect(t.client("permissions.dbo_id")).toEqual({
      value: "client.permissions.dbo_id",
      tag: "input",
      filters: [],
    });
  });

  it("error: exposes all 11 members; error(...) drills into children", () => {
    const t = buildTriggerHandle("error") as unknown as ErrorInputs;
    const names = Object.keys(buildTriggerHandle("error"));
    expect(names).toEqual([
      "event",
      "id",
      "signature",
      "error",
      "caller",
      "statement",
      "actor",
      "count",
      "first_seen",
      "last_seen",
      "fixed_at",
    ]);
    expect(t.error("message")).toEqual({ value: "error.message", tag: "input", filters: [] });
  });

  it("agent and mcp handles are identical (both toolset)", () => {
    expect(Object.keys(buildTriggerHandle("toolset"))).toEqual(["toolset", "tools"]);
  });

  it("accessor is both a value and callable", () => {
    const t = buildTriggerHandle("toolset") as unknown as ToolsetInputs;
    // whole-value form
    expect({ ...t.toolset }).toEqual({ value: "toolset", tag: "input", filters: [] });
    // callable form
    expect(t.toolset("name")).toEqual({ value: "toolset.name", tag: "input", filters: [] });
  });

  it("a bare accessor works as s.api.request params (issue #78 regression)", () => {
    // The canonical "mirror the whole row" trigger shape: `params: t.new`. In 3.6.0
    // this threw the misleading `c.obj` #42 error; the accessor is a *function*
    // Value, which coerceObj's object-only check missed. It must flatten to a plain
    // input Value and encode cleanly.
    const t = buildTriggerHandle("database") as unknown as { new: import("../../src/values/value.js").Value };
    const encoded = encodeStatement(
      s.api.request({ url: "https://example.com/hook", method: "POST", params: t.new, as: "resp" }),
    );
    const params = (encoded.input as Array<{ name: string; value: unknown; tag: string }>).find(
      (e) => e.name === "params",
    );
    expect(params).toMatchObject({ value: "new", tag: "input" });
  });
});

// --- Type-level assertions (verified by `tsc --noEmit`, not at runtime) ---
describe("trigger input handle — types (U2)", () => {
  it("valid members compile; unknown members do not", () => {
    const t = buildTriggerHandle("workspace_realtime_channel") as unknown as RealtimeInputs;
    void t.action;
    void t.client("permissions.dbo_id");
    // @ts-expect-error - `nope` is not a realtime input
    void t.nope;
    expect(true).toBe(true);
  });

  it("workspace exposes to_branch/from_branch/action", () => {
    const t = buildTriggerHandle("workspace") as unknown as WorkspaceInputs;
    void t.to_branch("label");
    void t.action;
    // @ts-expect-error - workspace has no `payload`
    void t.payload;
    expect(true).toBe(true);
  });
});
