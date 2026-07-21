import { describe, it, expect } from "vitest";
import { impliedInputs } from "../../src/kinds/trigger-inputs.js";
import { loadFixture, normalizedPair, normalize } from "../conformance/harness.js";

const fixtureInputs = (n: string) =>
  loadFixture<{ input: unknown[] }>(`triggers/${n}-trigger.json`).input;

describe("trigger implied inputs — conformance with Xano updateDefaults", () => {
  it("database: new/old/action/datasource deep-equal the fixture (R1)", () => {
    const { actual, expected } = normalizedPair(impliedInputs("database"), fixtureInputs("table"));
    expect(actual).toEqual(expected);
  });

  it("realtime: action/channel/client/options/payload deep-equal the fixture (R1)", () => {
    const { actual, expected } = normalizedPair(
      impliedInputs("workspace_realtime_channel"),
      fixtureInputs("realtime"),
    );
    expect(actual).toEqual(expected);
  });

  it("toolset: matches the mcp-server fixture (R1)", () => {
    const { actual, expected } = normalizedPair(impliedInputs("toolset"), fixtureInputs("mcp-server"));
    expect(actual).toEqual(expected);
  });

  it("agent and mcp-server share the toolset input array", () => {
    const { actual, expected } = normalizedPair(
      impliedInputs("toolset"),
      fixtureInputs("agent"),
    );
    expect(actual).toEqual(expected);
  });

  it("workspace: to_branch/from_branch/action deep-equal the fixture (R1)", () => {
    const { actual, expected } = normalizedPair(impliedInputs("workspace"), fixtureInputs("workspace"));
    expect(actual).toEqual(expected);
  });

  it("database datasource mirrors the quirky action-copied values (KTD-4 regression guard)", () => {
    const ds = impliedInputs("database").find((i) => i.name === "datasource")!;
    expect(ds.type).toBe("text");
    expect(ds.values).toEqual(["insert", "update", "delete", "truncate"]);
  });

  it("every injected field emits _xsid:'' (engine-assigned on import)", () => {
    for (const objType of ["database", "toolset", "workspace", "workspace_realtime_channel", "error"] as const) {
      for (const field of impliedInputs(objType)) {
        expect(field._xsid).toBe("");
      }
    }
  });

  // The shipped error-trigger.json fixture stores `input: []` — it predates the
  // rich error signature schema `buildErrorTriggerInputSchema` now generates.
  // updateDefaults is the authority, so error is asserted structurally against
  // that schema, not the stale fixture (see U6 / plan R6).
  it("error: rich signature schema (event/error/caller/... ) matches updateDefaults authority", () => {
    const inputs = normalize(impliedInputs("error")) as unknown as Array<Record<string, unknown>>;
    expect(inputs.map((i) => i.name)).toEqual([
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

    const event = inputs.find((i) => i.name === "event")!;
    expect(event.type).toBe("enum");
    expect(event.values).toEqual(["new", "regression", "fixed"]);
    expect(event.description).toContain("snapshot dedup window");

    const caller = inputs.find((i) => i.name === "caller")!;
    expect(caller.nullable).toBe(true);
    expect((caller.children as Array<{ name: string }>).map((c) => c.name)).toEqual([
      "type",
      "id",
      "name",
    ]);

    const error = inputs.find((i) => i.name === "error")!;
    expect((error.children as Array<{ name: string }>).map((c) => c.name)).toEqual([
      "code",
      "message",
    ]);
  });

  it("realtime client has nested permissions{dbo_id,row_id}; payload is nullable", () => {
    const inputs = impliedInputs("workspace_realtime_channel");
    const client = inputs.find((i) => i.name === "client")!;
    const permissions = (client.children as Array<{ name: string; children?: Array<{ name: string }> }>).find(
      (c) => c.name === "permissions",
    )!;
    expect(permissions.children!.map((c) => c.name)).toEqual(["dbo_id", "row_id"]);
    const payload = inputs.find((i) => i.name === "payload")!;
    expect(payload.nullable).toBe(true);
  });
});
