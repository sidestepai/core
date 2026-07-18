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
  it("encodes input/run + output block", () => {
    const a = encodeAddon({ name: "totals", input: { id: input.int() }, stack: [setVar("x1", c.int(1))] });
    expect(a.output).toEqual({ customize: false, items: [] });
    expect(a.context).toEqual({});
    expect(a.input).toHaveLength(1);
    expect(a.run).toHaveLength(1);
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
    expect(w.realtime).toEqual({ canonical: "" });
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
});
