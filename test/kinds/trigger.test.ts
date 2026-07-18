import { describe, it, expect } from "vitest";
import { trigger, encodeTrigger } from "../../src/kinds/trigger.js";
import { Xano } from "../../src/workspace/xano.js";
import { setVar } from "../../src/statements/set-var.js";
import { input } from "../../src/inputs/input.js";
import { c, inp } from "../../src/values/value.js";
import { loadFixture } from "../conformance/harness.js";

const metaOf = (n: string) => loadFixture<{ meta: unknown }>(`triggers/${n}-trigger.json`).meta;

describe("trigger kind — envelope + obj_type discrimination", () => {
  it("table trigger: obj_type=database, populated database action, config-only", () => {
    const t = encodeTrigger(
      trigger.table({
        name: "t",
        objId: 1,
        datasources: ["live"],
        actions: { insert: true, update: true },
        input: { score: input.int() },
        stack: [setVar("x1", c.int(1))],
      }),
    );
    expect(t.obj_type).toBe("database");
    expect((t.meta as any).database.action).toEqual({
      delete: false,
      insert: true,
      truncate: false,
      update: true,
    });
    expect((t.meta as any).database.datasource).toEqual([{ tag: "live" }]);
    expect(t.result).toEqual([]); // config-only
    expect(t.history).toEqual({ inherit: true, enabled: false, limit: 100 });
    expect(t.output).toEqual([]);
    expect(t.tag).toEqual([]);
    expect(t.active).toBe(true);
    expect(t.run).toHaveLength(1);
    expect(t.input).toHaveLength(1);
  });

  it("realtime trigger: meta deep-equals the real fixture meta; response-bearing", () => {
    const t = encodeTrigger(
      trigger.realtime({ name: "r", objId: 1, actions: { message: true }, response: inp("payload") }),
    );
    expect(t.obj_type).toBe("workspace_realtime_channel");
    expect(t.meta).toEqual(metaOf("realtime"));
    expect(t.result).toEqual([
      { filters: [], name: "", tag: "input", value: "payload", _xsid: "", disabled: false },
    ]);
  });

  it("mcp_server trigger: meta deep-equals fixture (toolset connection)", () => {
    const t = encodeTrigger(trigger.mcpServer({ name: "m", objId: 2, response: c.text("ok") }));
    expect(t.obj_type).toBe("toolset");
    expect(t.meta).toEqual(metaOf("mcp-server"));
    expect((t.meta as any).toolset.action.connection).toBe(true);
  });

  it("agent trigger: meta deep-equals fixture (toolset connection)", () => {
    const t = encodeTrigger(trigger.agent({ name: "a", objId: 2, response: c.text("ok") }));
    expect(t.obj_type).toBe("toolset");
    expect(t.meta).toEqual(metaOf("agent"));
  });

  it("workspace trigger: obj_type=workspace, branch actions, config-only", () => {
    const t = encodeTrigger(
      trigger.workspace({
        name: "w",
        actions: { branch_live: true, branch_merge: true, branch_new: true },
        stack: [setVar("x1", c.text("abc"))],
      }),
    );
    expect(t.obj_type).toBe("workspace");
    expect((t.meta as any).workspace.action).toEqual({
      branch_live: true,
      branch_merge: true,
      branch_new: true,
    });
    expect(t.result).toEqual([]);
  });

  it("error trigger: obj_type=error, empty meta, config-only", () => {
    const t = encodeTrigger(trigger.error({ name: "e", stack: [setVar("x1", c.text("err"))] }));
    expect(t.obj_type).toBe("error");
    expect(t.meta).toEqual({});
    expect(t.result).toEqual([]);
  });

  it("requires a name", () => {
    // @ts-expect-error - missing name
    expect(() => encodeTrigger(trigger.error({}))).toThrow(/name/);
  });

  it("registers on Xano under payload.trigger", () => {
    const bundle = new Xano()
      .register("trigger", trigger.error({ name: "e", stack: [setVar("x1", c.text("x"))] }))
      .export();
    expect(bundle.payload.trigger).toHaveLength(1);
    expect((bundle.payload.trigger as any)[0].obj_type).toBe("error");
  });
});
