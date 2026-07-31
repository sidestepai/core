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
import { workspace, defineFunction, apiGroup, query, task, s, c } from "../../src/index.js";

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

/**
 * A task's schedule end date, which four real tasks lost on the way back.
 *
 * `endsOn` drove BOTH stored members — `ends.on` and `ends.enabled` — so a
 * schedule whose end date is switched off but still remembered had no authored
 * form. The decoder dropped it (the gate was off) and the encoder then refilled
 * `ends.on` from `startsOn`, so the pulled task re-exported with a DIFFERENT end
 * date rather than a missing one. That is the same one-derivation-two-members
 * shape as the query paging gate, and it is fixed the same way: an additive
 * override that defaults to the derivation, stated only when the two disagree.
 */
describe("task schedule decode — a disabled end date is still carried", () => {
  /** Decode a real task after rewriting its stored `repeat.ends` block. */
  function decodeSchedule(ends: { enabled: boolean; on: string }, repeatEnabled = false) {
    const b = workspace("w")
      .registerTasks([
        task({
          name: "nightly",
          stack: [s.set_var("x", c.int(1))],
          schedule: [{ startsOn: STARTS, freq: 86400, repeatEnabled }],
        }),
      ])
      .export() as unknown as { payload: Record<string, unknown> };
    const stored = (b.payload.task as Array<{ schedule: Array<{ repeat: Record<string, unknown> }> }>)[0]!;
    stored.schedule[0]!.repeat.ends = ends;
    return decodeBundle(b).files.map((f) => f.contents).join("\n");
  }

  const STARTS = "2022-05-27 22:31:04+0000";

  it("recovers a remembered end date sitting behind a disabled gate", () => {
    const source = decodeSchedule({ enabled: false, on: "2022-05-27 22:30:04+0000" });
    expect(source).toContain('endsOn: "2022-05-27 22:30:04+0000"');
    // Without the gate the encoder would read that date as switching ends ON.
    expect(source).toContain("endsEnabled: false");
  });

  it("says neither when the stored end date is the encoder's own filler", () => {
    // The common case, and the reason the override stays invisible: an unset end
    // date is stored as `on: <starts_on>` with the gate off, which the
    // derivation already reproduces exactly.
    const source = decodeSchedule({ enabled: false, on: STARTS });
    expect(source).not.toContain("endsOn");
    expect(source).not.toContain("endsEnabled");
  });

  it("states only the date when the gate is genuinely on", () => {
    const source = decodeSchedule({ enabled: true, on: "2023-01-01 00:00:00+0000" }, true);
    expect(source).toContain('endsOn: "2023-01-01 00:00:00+0000"');
    expect(source).not.toContain("endsEnabled");
  });
});

/**
 * A query's saved request/response sample. Nothing in this SDK models it, so a
 * pull cannot carry it — which must be SAID, not done silently. Two real queries
 * store one, and both were reading as a broken round trip instead.
 */
describe("query example — unmodeled, and said out loud", () => {
  function decodeWithExample(example: unknown) {
    const b = workspace("w")
      .registerApiGroups([apiGroup({ name: "public" })])
      .registerQueries([
        query({ name: "hello", verb: "GET", apiGroup: "public", stack: [s.set_var("x", c.int(1))] }),
      ])
      .export() as unknown as { payload: Record<string, unknown> };
    (b.payload.query as Array<Record<string, unknown>>)[0]!.example = example;
    return decodeBundle(b).report.entries.filter((e) => e.detail.includes("example"));
  }

  it("reports a populated example as an omission", () => {
    const named = decodeWithExample({ input: { abc: 123 }, output: { abc: "test" } });
    expect(named).toHaveLength(1);
    expect(named[0]!.category).toBe("expected-omission");
  });

  it("says nothing when there is no example to leave behind", () => {
    expect(decodeWithExample({})).toEqual([]);
  });
});

/**
 * Agent/MCP LLM settings on the read path.
 *
 * `agent()` and `mcpServer()` are two authoring surfaces over ONE stored
 * `mvp_toolset` row, distinguished only by `type` — so an MCP server can carry
 * the same `agent_settings` an agent does, and a real one does.
 *
 * The provider surfaces are NOT interchangeable, though: `xano-free` is a
 * wrapper that declares no `model`/`apiKey` of its own, while the stored config
 * can hold both. Reading those onto the typed field would emit a generated tree
 * that does not type-check, and dropping them loses stored settings silently —
 * so they go to `extraConfig`, the escape hatch the encoder already merges last.
 */
describe("toolset llm settings — carried for both surfaces", () => {
  function decodeToolset(stored: Record<string, unknown>) {
    const b = workspace("w").export() as unknown as { payload: Record<string, unknown> };
    b.payload.toolset = [
      { name: "asdf", guid: "g1", canonical: "c1", tool: [], enabled: true, ...stored },
    ];
    const project = decodeBundle(b);
    return project.files.map((f) => f.contents).join("\n");
  }

  const settings = (config: Record<string, unknown>) => ({
    type: "xano-free",
    system_prompt: "be brief",
    max_steps: 5,
    prompt_type: "prompt",
    prompt: "",
    prompt_messages: "",
    structuredOutputs: false,
    structuredOutputsSchema: [],
    configs: { "xano-free": config },
  });

  it("recovers an MCP server's llm block, not just an agent's", () => {
    const source = decodeToolset({ type: "mcp", agent_settings: settings({ temperature: 1 }) });
    expect(source).toContain("mcpServer(");
    expect(source).toContain('systemPrompt: "be brief"');
  });

  it("says nothing about llm for an MCP server that stores none", () => {
    const source = decodeToolset({ type: "mcp" });
    expect(source).toContain("mcpServer(");
    expect(source).not.toContain("llm:");
  });

  it("routes a provider-config key the typed surface cannot declare to extraConfig", () => {
    // `xano-free` declares no `model`/`apiKey`. Emitting them as typed fields
    // produced a tree that fails tsc; skipping them lost real stored settings.
    const source = decodeToolset({
      type: "mcp",
      agent_settings: settings({ temperature: 1, model: "gemini-2.5-flash-lite", apiKey: "k" }),
    });
    expect(source).toContain("extraConfig:");
    // Nested INSIDE extraConfig, not a sibling of it — `model` is not a field
    // `XanoFreeLlm` declares, so a sibling would not type-check.
    expect(source.indexOf("extraConfig:")).toBeLessThan(source.indexOf('model: "gemini-2.5-flash-lite"'));
    expect(source).toContain('apiKey: "k"');
  });

  it("still reads a provider's OWN model onto its typed field", () => {
    // The paired negative: google-genai does declare `model`, so it must not be
    // pushed into the escape hatch.
    const source = decodeToolset({
      type: "agent",
      agent_settings: {
        ...settings({ temperature: 1, model: "gemini-2.5-pro" }),
        type: "google-genai",
        configs: { "google-genai": { temperature: 1, model: "gemini-2.5-pro" } },
      },
    });
    expect(source).toContain('model: "gemini-2.5-pro"');
    expect(source).not.toContain("extraConfig:");
  });
});
