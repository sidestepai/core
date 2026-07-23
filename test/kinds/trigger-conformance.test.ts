/**
 * Trigger conformance (U6). Proves the full `*Trigger(...)` → `encodeTrigger`
 * path injects the exact Xano input array for every type, that the injected
 * inputs survive a full Xano register/export round-trip, and that the
 * response-bearing defaults match the shipped fixtures' `run`/`result`.
 *
 * The shipped `error-trigger.json` fixture stores `input: []` — it predates the
 * rich error signature schema `buildErrorTriggerInputSchema` now generates.
 * `updateDefaults` is the authority (Xano is a third party we mirror), so error
 * inputs are asserted structurally against that schema in
 * `trigger-inputs.test.ts` rather than against the stale fixture.
 */
import { describe, it, expect } from "vitest";
import {
  tableTrigger,
  realtimeTrigger,
  mcpServerTrigger,
  workspaceTrigger,
  encodeTrigger,
} from "../../src/kinds/trigger.js";
import { Xano } from "../../src/workspace/xano.js";
import { impliedInputs } from "../../src/kinds/trigger-inputs.js";
import { loadFixture, normalizedPair } from "../conformance/harness.js";

const fixture = (n: string) => loadFixture<{ input: unknown[]; run: unknown[]; result: unknown[] }>(
  `triggers/${n}-trigger.json`,
);

describe("trigger factory → encode → fixture conformance (U6)", () => {
  it("table: factory path injects the database input array (R1/R6)", () => {
    const t = encodeTrigger(tableTrigger({ name: "t", objId: 1, actions: { insert: true } }));
    const { actual, expected } = normalizedPair(t.input, fixture("table").input);
    expect(actual).toEqual(expected);
  });

  it("realtime: factory path injects the realtime input array (R1/R6)", () => {
    const t = encodeTrigger(realtimeTrigger({ name: "r", objId: 1, actions: { message: true } }));
    const { actual, expected } = normalizedPair(t.input, fixture("realtime").input);
    expect(actual).toEqual(expected);
  });

  it("mcpServer: factory path injects the toolset input array (R1/R6)", () => {
    const t = encodeTrigger(mcpServerTrigger({ name: "m", objId: 2 }));
    const { actual, expected } = normalizedPair(t.input, fixture("mcp-server").input);
    expect(actual).toEqual(expected);
  });

  it("workspace: factory path injects the workspace input array (R1/R6)", () => {
    const t = encodeTrigger(workspaceTrigger({ name: "w", actions: { branch_live: true } }));
    const { actual, expected } = normalizedPair(t.input, fixture("workspace").input);
    expect(actual).toEqual(expected);
  });

  it("mcpServer default run/result match the fixture's var passthrough (KTD-5)", () => {
    const t = encodeTrigger(mcpServerTrigger({ name: "m", objId: 2 }));
    // The default run copies the toolset/tools inputs into like-named vars
    // (mirroring Xano's updateRun). Assert structurally — the full set_var
    // statement envelope drifts between fixture and SDK generations, which is
    // the statement encoder's concern, not the trigger's.
    expect(t.run).toHaveLength(2);
    expect(t.run[0]).toMatchObject({ name: "mvp:set_var", as: "toolset", context: { value: "toolset", tag: "input" } });
    expect(t.run[1]).toMatchObject({ name: "mvp:set_var", as: "tools", context: { value: "tools", tag: "input" } });
    // The default result (updateResult) is exact — result items are trigger-owned.
    const result = normalizedPair(t.result, fixture("mcp-server").result);
    expect(result.actual).toEqual(result.expected);
  });

  it("realtime default result matches the fixture's payload passthrough (KTD-5)", () => {
    const t = encodeTrigger(realtimeTrigger({ name: "r", objId: 1, actions: { message: true } }));
    const { actual, expected } = normalizedPair(t.result, fixture("realtime").result);
    expect(actual).toEqual(expected);
  });

  it("full-envelope round-trip: exported trigger carries the injected input[] (R6)", () => {
    const bundle = new Xano()
      .register("trigger", tableTrigger({ name: "on_insert", objId: 1, actions: { insert: true } }))
      .export();
    const exported = (bundle.payload.trigger as Array<{ input: unknown[]; obj_type: string }>)[0]!;
    expect(exported.obj_type).toBe("database");
    expect(exported.input).toEqual(impliedInputs("database"));
  });
});
