import { describe, it, expect } from "vitest";
import { encodeTask, encodeSchedule, taskKind } from "../../src/kinds/task.js";
import { encodeMiddleware, middlewareKind } from "../../src/kinds/middleware.js";
import { encodeAddon, addonKind } from "../../src/kinds/addon.js";
import { encodeWorkspaceConfig, workspaceKind } from "../../src/kinds/workspace-config.js";
import { Xano } from "../../src/workspace/xano.js";
import { setVar } from "../../src/statements/set-var.js";
import { input } from "../../src/inputs/input.js";
import { c, ref } from "../../src/values/value.js";
import { normalize, loadFixture } from "../conformance/harness.js";

describe("task kind", () => {
  it("schedule entries deep-equal the real fixture (minus _xsid)", () => {
    const fx = loadFixture<{ schedule: Array<any> }>("misc/task.json");
    const s0 = fx.schedule[0];
    const s1 = fx.schedule[1];
    expect(normalize(encodeSchedule({ startsOn: s0.starts_on, freq: 86400, endsOn: s0.repeat.ends.on, repeatEnabled: true }))).toEqual(
      normalize(s0),
    );
    expect(normalize(encodeSchedule({ startsOn: s1.starts_on, freq: 86400, repeatEnabled: false }))).toEqual(
      normalize(s1),
    );
  });

  it("lets a REMEMBERED end date sit behind a disabled gate", () => {
    // `endsOn` drove both stored members — `ends.on` AND `ends.enabled` — so a
    // schedule whose end date is switched off but still remembered had no
    // authored form. Four real tasks store exactly that, and every one of them
    // re-exported with its end date replaced by its START date, because the
    // encoder filled the gap with `startsOn`. Same shape as the paging gate:
    // one derivation driving two members that real data lets disagree.
    const remembered = encodeSchedule({
      startsOn: "2022-05-27 22:31:04+0000",
      endsOn: "2022-05-27 22:30:04+0000",
      endsEnabled: false,
      freq: 86400,
      repeatEnabled: false,
    });
    expect(remembered.repeat.ends).toEqual({ enabled: false, on: "2022-05-27 22:30:04+0000" });
  });

  it("still derives the gate from `endsOn` when it is not stated", () => {
    // The paired negative — an additive override must change nothing unset.
    expect(encodeSchedule({ startsOn: "A", endsOn: "B" }).repeat.ends).toEqual({
      enabled: true,
      on: "B",
    });
    expect(encodeSchedule({ startsOn: "A" }).repeat.ends).toEqual({ enabled: false, on: "A" });
  });

  it("encodes the task envelope", () => {
    const t = encodeTask({ name: "nightly", active: true, stack: [setVar("x1", c.int(1))] });
    expect(t.active).toBe(true);
    expect(t.history).toEqual({ inherit: true, enabled: true, limit: 100 });
    expect(t.run).toHaveLength(1);
    expect(t.schedule).toEqual([]);
    expect(taskKind.payloadKey).toBe("task");
  });
});

describe("middleware kind", () => {
  it("encodes result_type / exception and reuses input/result/run", () => {
    const m = encodeMiddleware({
      name: "auth-mw",
      resultStrategy: "replace",
      exceptionPolicy: "rethrow",
      input: { token: input.text() },
      stack: [setVar("x1", c.int(1))],
      response: ref("x1"),
    });
    expect(m.result_type).toBe("replace");
    expect(m.exception).toBe("rethrow");
    expect(m.shared_workspace).toEqual({ is_shared: false });
    expect(m.result).toEqual([
      { filters: [], name: "", tag: "var", value: "x1", _xsid: "", disabled: false },
    ]);
    expect(m.input).toHaveLength(1);
    expect(middlewareKind.payloadKey).toBe("middleware");
  });

  it("defaults to merge/silent", () => {
    const m = encodeMiddleware({ name: "m" });
    expect(m.result_type).toBe("merge");
    expect(m.exception).toBe("silent");
  });
});

describe("addon kind", () => {
  it("encodes input + output block (an addon is its context, not a stack)", () => {
    const a = encodeAddon({ name: "totals", input: { id: input.int() } });
    expect(a.output).toEqual({ customize: false, items: [] });
    expect(a.context).toEqual({});
    expect(a.input).toHaveLength(1);
    expect(addonKind.payloadKey).toBe("addon");
  });
});

describe("workspace config kind", () => {
  it("emits the authored settings subset", () => {
    const w = encodeWorkspaceConfig({
      name: "b12",
      description: "nice",
      preferences: { track_performance: true },
      settings: { ai_enabled: true },
    });
    expect(w.name).toBe("b12");
    expect(w.preferences).toEqual({ track_performance: true });
    expect(w.settings).toEqual({ ai_enabled: true });
    // The legacy realtime block is carried verbatim, so an unauthored one is the
    // engine's own empty shape rather than a canonical this SDK invented.
    expect(w.realtime).toEqual({ hash: "", mode: "", enabled: false, channels: [] });
    expect(w.documentation).toEqual({ token: "", whitelist: {}, require_token: false });
    expect(w.swagger).toBe(false);
    expect(workspaceKind.payloadKey).toBe("workspace");
  });
});

describe("U8 kinds on Xano", () => {
  it("lands under the right payload keys; workspace is a singleton object", () => {
    const bundle = new Xano()
      .register("task", { name: "t" })
      .register("middleware", { name: "m" })
      .register("addon", { name: "a" })
      .registerWorkspace({ name: "ws", description: "hi" })
      .export();
    expect(bundle.payload.task).toHaveLength(1);
    expect(bundle.payload.middleware).toHaveLength(1);
    expect(bundle.payload.addon).toHaveLength(1);
    expect(bundle.payload.workspace).toMatchObject({ name: "ws", description: "hi" });
  });

  it("routes workspace env vars to the top-level payload.env (the import's read location), leaving workspace.env empty", () => {
    const bundle = new Xano()
      .registerWorkspace({ name: "ws", env: { STRIPE_KEY: "sk_1", APP_URL: "https://x" } })
      .export();
    // The engine merges env from payload.env, NOT the workspace object.
    expect(bundle.payload.env).toEqual([
      { name: "STRIPE_KEY", value: "sk_1", market_item: [] },
      { name: "APP_URL", value: "https://x", market_item: [] },
    ]);
    expect((bundle.payload.workspace as { env: unknown[] }).env).toEqual([]);
  });

  it("keeps payload.env empty when no env vars are authored", () => {
    const bundle = new Xano().registerWorkspace({ name: "ws" }).export();
    expect(bundle.payload.env).toEqual([]);
    expect((bundle.payload.workspace as { env: unknown[] }).env).toEqual([]);
  });
});

describe("workspace-tier middleware", () => {
  it("omits the middleware key when the author sets none", () => {
    const w = encodeWorkspaceConfig({ name: "b12" });
    expect("middleware" in w).toBe(false);
  });

  it("emits the full 8-key map (no _customize flags) when provided", () => {
    const w = encodeWorkspaceConfig({
      name: "b12",
      middleware: { query: { pre: ["rateLimit"] }, function: { post: ["audit"] }, tool: { pre: ["guard"] } },
    });
    const m = w.middleware!;
    expect(Object.keys(m).sort()).toEqual([
      "function_post", "function_pre", "query_post", "query_pre",
      "task_post", "task_pre", "tool_post", "tool_pre",
    ]);
    // Only the specified host/phase populated; the rest empty.
    expect(m.query_pre).toHaveLength(1);
    expect(m.function_post).toHaveLength(1);
    expect(m.tool_pre).toHaveLength(1);
    expect(m.query_post).toEqual([]);
    expect(m.task_pre).toEqual([]);
    // No _customize flags at this (terminal) tier — the 8-key assertion above
    // already pins the exact key set; here we confirm the override flags are absent.
    expect("pre_customize" in m).toBe(false);
    expect("post_customize" in m).toBe(false);
    // Entry is a full mvp:middleware stack item.
    expect((m.query_pre[0] as { name: string }).name).toBe("mvp:middleware");
  });
});

describe("workspace-tier history", () => {
  it("omits the history key when the author sets none (byte-parity)", () => {
    const w = encodeWorkspaceConfig({ name: "b12" });
    expect("history" in w).toBe(false);
  });

  it("emits the 14-key map at engine defaults, no inherit (matches golden)", () => {
    const w = encodeWorkspaceConfig({ name: "b12", history: {} });
    expect(w.history).toEqual({
      query_enabled: true,
      query_limit: 100,
      function_enabled: false,
      function_limit: 100,
      task_enabled: true,
      task_limit: 100,
      tool_enabled: true,
      tool_limit: 100,
      trigger_enabled: false,
      trigger_limit: 100,
      middleware_enabled: false,
      middleware_limit: 100,
      message_enabled: false,
      message_limit: 100,
    });
    expect("inherit" in w.history!).toBe(false);
  });

  it("wholesale: listed types override, omitted types stay at defaults", () => {
    const w = encodeWorkspaceConfig({
      name: "b12",
      history: { query: 100, function: true, trigger: "all" },
    });
    const h = w.history!;
    expect(h).toMatchObject({
      query_enabled: true,
      query_limit: 100,
      function_enabled: true,
      function_limit: 100,
      trigger_enabled: true,
      trigger_limit: -1,
      // untouched types keep engine defaults
      task_enabled: true,
      middleware_enabled: false,
    });
    // No `test_*` keys and no branch block at this tier.
    expect("test_enabled" in h).toBe(false);
    expect("branch" in w).toBe(false);
  });
});

/**
 * U7 — the workspace-level slots that mismatched on every real workspace, so no
 * workspace could ever verify clean and every genuine per-object diff was buried
 * underneath the noise.
 *
 * The legacy realtime and documentation blocks are carried verbatim: SideStep
 * models none of their members, so the contract is "whatever the engine stored
 * round-trips", not "this SDK understands this shape".
 */
describe("workspace config — verbatim server blocks", () => {
  it("round-trips a legacy realtime block it does not model", () => {
    const legacy = { hash: "abc", mode: "shared", enabled: true, channels: ["a", "b"] };
    expect(encodeWorkspaceConfig({ name: "ws", realtime: legacy }).realtime).toEqual(legacy);
  });

  it("round-trips a documentation block it does not model", () => {
    const docs = { token: "t0k", whitelist: { "10.0.0.1": true }, require_token: true };
    expect(encodeWorkspaceConfig({ name: "ws", documentation: docs }).documentation).toEqual(docs);
  });

  it("carries an unmodelled member of a verbatim block through untouched", () => {
    // The point of verbatim: a member this SDK has never heard of still survives.
    const withExtra = { hash: "", mode: "", enabled: false, channels: [], future_key: 42 };
    expect(encodeWorkspaceConfig({ name: "ws", realtime: withExtra }).realtime).toEqual(withExtra);
  });

  it("emits the engine's own empty defaults when the blocks are unauthored", () => {
    const w = encodeWorkspaceConfig({ name: "ws" });
    expect(w.realtime).toEqual({ hash: "", mode: "", enabled: false, channels: [] });
    expect(w.documentation).toEqual({ token: "", whitelist: {}, require_token: false });
    expect(w.swagger).toBe(false);
  });

  it("round-trips an enabled swagger flag", () => {
    expect(encodeWorkspaceConfig({ name: "ws", swagger: true }).swagger).toBe(true);
    expect(encodeWorkspaceConfig({ name: "ws", swagger: false }).swagger).toBe(false);
  });

  it("emits a history pair for the realtime message tier", () => {
    // The engine stores 14 keys at this tier; a 12-key map mismatched every time.
    const w = encodeWorkspaceConfig({ name: "ws", history: { message: true } });
    expect(w.history).toMatchObject({ message_enabled: true, message_limit: 100 });
    expect(Object.keys(w.history!)).toHaveLength(14);
  });
});
