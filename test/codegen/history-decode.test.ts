/**
 * Reading a stored request-history block back into its scalar authoring form.
 *
 * The `history:` surface is a scalar (`true`, `false`, `"all"`, or a row limit)
 * over a stored `{inherit, enabled, limit}` block, so not every stored block has
 * an authored spelling — and the decoder reports the ones that do not.
 *
 * A full 187-workspace sweep showed it reporting 27 blocks that were not that
 * case at all: every one carried `inherit: true`. An inheriting block takes its
 * setting from the parent tier, which makes its own `enabled`/`limit` members
 * inert — and `normalize`, the comparison that judges every round trip, already
 * drops ANY inheriting block for exactly that reason. So the decoder was
 * reporting a divergence its own byte-comparison had already ruled out, on
 * objects that verified clean.
 *
 * The 28th was a task carrying `history` as an ARRAY: engine-recorded run
 * telemetry (`on`, `duration`, `debugger`), which is not a settings block at all
 * and cannot have a scalar form because it is not authored data.
 */
import { describe, it, expect } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import { workspace, defineFunction, apiGroup, s, c } from "../../src/index.js";

/** A bundle with one function and one API group, both at their history default. */
function bundle(): { payload: Record<string, unknown> } {
  return workspace("w")
    .registerFunctions([defineFunction({ name: "signup", stack: [s.set_var("x", c.int(1))] })])
    .registerApiGroups([apiGroup({ name: "public" })])
    .export() as unknown as { payload: Record<string, unknown> };
}

/** Decode after overwriting one object's stored `history` block. */
function decodeWithHistory(section: string, history: unknown) {
  const b = bundle();
  const objects = b.payload[section] as Array<Record<string, unknown>>;
  objects[0]!.history = history;
  return decodeBundle(b);
}

/** The report lines that named a history block. */
function historyProblems(project: { report: { entries: readonly { detail: string; category: string }[] } }) {
  return project.report.entries.filter((e) => e.detail.includes("history"));
}

describe("history decode — an inheriting block is the default, not an unauthorable one", () => {
  it("elides an inheriting object-tier block whose other members drifted", () => {
    // `limit: 0` with `enabled: false` has no scalar spelling in isolation — but
    // `inherit: true` makes both inert, so there is nothing to spell.
    const project = decodeWithHistory("function", { inherit: true, enabled: false, limit: 0 });
    expect(historyProblems(project)).toEqual([]);
  });

  it("elides an inheriting container-tier block that omits its limit", () => {
    // The lean-vs-full generational gap again: an API group saved by an older
    // engine stores `{inherit, query_enabled}` with no `query_limit` at all.
    // 10 real API groups store exactly this, and 71 store it with the limit.
    const project = decodeWithHistory("app", { inherit: true, query_enabled: true });
    expect(historyProblems(project)).toEqual([]);
  });

  it("still reports a block that genuinely has no scalar form", () => {
    // The paired negative: `inherit: false` means the block IS authored, and
    // "off, but with a custom limit" is a state the scalar cannot say.
    const project = decodeWithHistory("function", { inherit: false, enabled: false, limit: 5 });
    expect(historyProblems(project)).toHaveLength(1);
    expect(historyProblems(project)[0]!.category).toBe("verify-mismatch");
  });

  it("still recovers an authored block that DOES have a scalar form", () => {
    const project = decodeWithHistory("function", { inherit: false, enabled: true, limit: -1 });
    expect(historyProblems(project)).toEqual([]);
    const source = project.files.map((f) => f.contents).join("\n");
    expect(source).toContain('history: "all"');
  });

  it("reports engine-recorded run telemetry as an omission, not a mismatch", () => {
    // A stored ARRAY is not a settings block — it is the engine's own record of
    // past runs. Declining to write it into a committed source tree is correct,
    // so it must not read as a broken round trip.
    const project = decodeWithHistory("function", [
      { on: "2022-01-14 23:16:11+0000", duration: 0.168, debugger: { status: "ok" } },
    ]);
    const named = historyProblems(project);
    expect(named).toHaveLength(1);
    expect(named[0]!.category).toBe("expected-omission");
  });
});
