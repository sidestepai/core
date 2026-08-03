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
  errorTrigger,
  encodeTrigger,
} from "../../src/kinds/trigger.js";
import { Xano } from "../../src/workspace/xano.js";
import { impliedInputs } from "../../src/kinds/trigger-inputs.js";
import { loadFixture, normalizedPair } from "../conformance/harness.js";
import { c, col } from "../../src/values/value.js";
import { and, cmp, or } from "../../src/statements/expression.js";

const fixture = (n: string) => loadFixture<{ input: unknown[]; run: unknown[]; result: unknown[]; meta: unknown }>(
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

describe("tableTrigger `search` — the trigger condition (custom filter)", () => {
  it("encodes byte-equal to the engine fixture's stored search block", () => {
    // `table-trigger.json` carries a real custom filter captured off an engine.
    // This is the byte claim: authoring the condition reproduces what Xano wrote.
    const t = encodeTrigger(
      tableTrigger({
        name: "t",
        objId: 1,
        actions: { insert: true, update: true },
        datasources: ["live"],
        search: cmp(col("NEW.id"), "=", c.int(123)),
      }),
    );
    // Compared as `{meta}`, not bare: the inert-group equivalence is keyed on the
    // `meta` KEY, and this fixture is old enough to omit two of the six groups.
    // The `database` block — action flags, datasource, and the search expression
    // this test is about — is matched exactly either way.
    const { actual, expected } = normalizedPair({ meta: t.meta }, { meta: fixture("table").meta });
    expect(actual).toEqual(expected);
  });

  it("writes the empty block when no condition is given", () => {
    const t = encodeTrigger(tableTrigger({ name: "t", objId: 1, actions: { insert: true } }));
    expect((t.meta as any).database.search).toEqual({ expression: [] });
  });

  it("rejects a filter on `truncate`, which has no row to test", () => {
    expect(() =>
      tableTrigger({
        name: "t",
        actions: { truncate: true },
        search: cmp(col("NEW.id"), "=", c.int(1)),
      }),
    ).toThrow(/truncate/);
  });

  it("rejects `OLD.*` when the trigger fires on insert", () => {
    // An insert has no OLD row, so the condition could never be evaluated.
    expect(() =>
      tableTrigger({
        name: "t",
        actions: { insert: true },
        search: cmp(col("OLD.status"), "=", c.text("x")),
      }),
    ).toThrow(/OLD\.status/);
  });

  it("rejects `NEW.*` when the trigger fires on delete", () => {
    expect(() =>
      tableTrigger({
        name: "t",
        actions: { delete: true },
        search: cmp(col("NEW.status"), "=", c.text("x")),
      }),
    ).toThrow(/NEW\.status/);
  });

  it("rejects the forbidden side even when another action would allow it", () => {
    // `{insert, update}` reading OLD.*: update could evaluate it, insert could
    // not, and the engine runs one trigger for both.
    expect(() =>
      tableTrigger({
        name: "t",
        actions: { insert: true, update: true },
        search: cmp(col("OLD.status"), "=", c.text("x")),
      }),
    ).toThrow(/OLD\.status/);
  });

  it("allows `OLD.*` on update+delete, where both sides exist", () => {
    expect(() =>
      tableTrigger({
        name: "t",
        actions: { update: true, delete: true },
        search: cmp(col("OLD.status"), "=", c.text("x")),
      }),
    ).not.toThrow();
  });

  it("finds a forbidden operand nested inside a grouped condition", () => {
    // The check walks the whole encoded tree, not just top-level terms.
    expect(() =>
      tableTrigger({
        name: "t",
        actions: { insert: true },
        search: and(cmp(col("NEW.a"), "=", c.int(1)), or(cmp(col("OLD.b"), "=", c.int(2)), cmp(col("NEW.c"), "=", c.int(3)))),
      }),
    ).toThrow(/OLD\.b/);
  });
});

describe("errorTrigger meta — inert, and consistent with every other type", () => {
  it("writes the same six-group skeleton the other types write", () => {
    const err = encodeTrigger(errorTrigger({ name: "e", objId: 1 }));
    const tbl = encodeTrigger(tableTrigger({ name: "t", objId: 1 }));
    // No `error` group exists — an error trigger has no action toggles — so the
    // two skeletons are identical.
    expect(Object.keys(err.meta as object).sort()).toEqual(Object.keys(tbl.meta as object).sort());
  });

  it("compares equal to the fixture's partial meta, because both are all-off", () => {
    // The shipped fixture stores two of the six groups; the SDK writes all six.
    // The engine reads every group as `?? false`, so these are one state — which
    // is exactly what the normalizer's inert-group rule encodes.
    const err = encodeTrigger(errorTrigger({ name: "e", objId: 1 }));
    const { actual, expected } = normalizedPair(
      { meta: err.meta },
      { meta: fixture("error").meta },
    );
    expect(actual).toEqual(expected);
  });
});
