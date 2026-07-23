import { describe, it, expect } from "vitest";
import {
  tableTrigger,
  realtimeTrigger,
  mcpServerTrigger,
  agentTrigger,
  workspaceTrigger,
  errorTrigger,
  encodeTrigger,
} from "../../src/kinds/trigger.js";
import { mcpServer } from "../../src/kinds/mcp-server.js";
import { agent } from "../../src/kinds/agent.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { Xano } from "../../src/workspace/xano.js";
import { setVar } from "../../src/statements/set-var.js";
import { c } from "../../src/values/value.js";
import { impliedInputs } from "../../src/kinds/trigger-inputs.js";
import { loadFixture } from "../conformance/harness.js";

const metaOf = (n: string) => loadFixture<{ meta: unknown }>(`triggers/${n}-trigger.json`).meta;

describe("trigger kind — envelope + obj_type discrimination", () => {
  it("table trigger: obj_type=database, populated database action, config-only", () => {
    const t = encodeTrigger(
      tableTrigger({
        name: "t",
        objId: 1,
        datasources: ["live"],
        actions: { insert: true, update: true },
        stack: (i) => [setVar("x1", i.action)],
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
  });

  it("injects the implied inputs regardless of stack (R1/R4)", () => {
    const t = encodeTrigger(tableTrigger({ name: "t", objId: 1, actions: { insert: true } }));
    expect(t.input).toEqual(impliedInputs("database"));
  });

  it("stack callback references implied inputs by typed name (R2)", () => {
    const t = encodeTrigger(
      tableTrigger({ name: "t", objId: 1, actions: { insert: true }, stack: (i) => [setVar("a", i.action)] }),
    );
    expect(t.run[0]).toMatchObject({ name: "mvp:set_var", as: "a", context: { value: "action", tag: "input" } });
  });

  it("realtime trigger: meta deep-equals the real fixture meta; response-bearing", () => {
    const t = encodeTrigger(realtimeTrigger({ name: "r", objId: 1, actions: { message: true } }));
    expect(t.obj_type).toBe("workspace_realtime_channel");
    expect(t.meta).toEqual(metaOf("realtime"));
    // Xano default (updateResult): payload passthrough.
    expect(t.result).toEqual([
      { filters: [], name: "", tag: "input", value: "payload", _xsid: "", disabled: false },
    ]);
    expect(t.input).toEqual(impliedInputs("workspace_realtime_channel"));
  });

  it("realtime: custom response overrides the payload default", () => {
    const t = encodeTrigger(
      realtimeTrigger({ name: "r", objId: 1, actions: { message: true }, response: (i) => i.payload }),
    );
    // response(i) => i.payload is the same payload passthrough
    expect(t.result).toEqual([
      { filters: [], name: "", tag: "input", value: "payload", _xsid: "", disabled: false },
    ]);
  });

  it("mcp_server trigger: meta deep-equals fixture; default toolset/tools var passthrough", () => {
    const t = encodeTrigger(mcpServerTrigger({ name: "m", objId: 2 }));
    expect(t.obj_type).toBe("toolset");
    expect(t.meta).toEqual(metaOf("mcp-server"));
    expect((t.meta as any).toolset.action.connection).toBe(true);
    // Default run copies inputs into vars; default result returns those vars.
    expect(t.run).toHaveLength(2);
    expect(t.result).toEqual([
      { filters: [], name: "toolset", tag: "var", value: "toolset", _xsid: "", disabled: false },
      { filters: [], name: "tools", tag: "var", value: "tools", _xsid: "", disabled: false },
    ]);
  });

  it("agent trigger: meta deep-equals fixture (toolset connection)", () => {
    const t = encodeTrigger(agentTrigger({ name: "a", objId: 2 }));
    expect(t.obj_type).toBe("toolset");
    expect(t.meta).toEqual(metaOf("agent"));
  });

  it("mcp_server trigger binds by handle → md5('toolset:'+name) guid (guid-stable, not id)", () => {
    const server = mcpServer({ name: "books" });
    const t = encodeTrigger(mcpServerTrigger({ name: "m", mcpServer: server }));
    expect(t.obj_id).toBe(deriveGuid("toolset", "books"));
    // Binding by bare name resolves identically.
    const byName = encodeTrigger(mcpServerTrigger({ name: "m", mcpServer: "books" }));
    expect(byName.obj_id).toBe(deriveGuid("toolset", "books"));
  });

  it("agent trigger binds by handle → the same toolset guid the agent stamps", () => {
    const a = agent({ name: "assistant", llm: { type: "xano-free" } });
    const t = encodeTrigger(agentTrigger({ name: "a", agent: a }));
    expect(t.obj_id).toBe(deriveGuid("toolset", "assistant"));
  });

  it("toolset trigger: raw objId escape hatch still works; handle wins over objId", () => {
    expect(encodeTrigger(mcpServerTrigger({ name: "m", objId: 7 })).obj_id).toBe(7);
    // Handle takes precedence over a raw objId (mirrors the table trigger).
    const t = encodeTrigger(mcpServerTrigger({ name: "m", mcpServer: "books", objId: 7 }));
    expect(t.obj_id).toBe(deriveGuid("toolset", "books"));
  });

  it("workspace trigger: obj_type=workspace, branch actions, config-only", () => {
    const t = encodeTrigger(
      workspaceTrigger({
        name: "w",
        actions: { branch_live: true, branch_merge: true, branch_new: true },
        stack: (i) => [setVar("x1", i.action)],
      }),
    );
    expect(t.obj_type).toBe("workspace");
    expect((t.meta as any).workspace.action).toEqual({
      branch_live: true,
      branch_merge: true,
      branch_new: true,
    });
    expect(t.result).toEqual([]);
    expect(t.input).toEqual(impliedInputs("workspace"));
  });

  it("error trigger: obj_type=error, empty meta, config-only, rich implied inputs", () => {
    const t = encodeTrigger(errorTrigger({ name: "e", stack: (i) => [setVar("x1", i.error("code"))] }));
    expect(t.obj_type).toBe("error");
    expect(t.meta).toEqual({});
    expect(t.result).toEqual([]);
    expect(t.input).toEqual(impliedInputs("error"));
    expect(t.run[0]).toMatchObject({ context: { value: "error.code", tag: "input" } });
  });

  it("requires a name", () => {
    // @ts-expect-error - missing name
    expect(() => encodeTrigger(errorTrigger({}))).toThrow(/name/);
  });

  it("no longer accepts a user-supplied input map (R4)", () => {
    // @ts-expect-error - `input` is not a trigger arg
    tableTrigger({ name: "t", objId: 1, input: { foo: c.int(1) } });
    expect(true).toBe(true);
  });

  it("registers on Xano under payload.trigger", () => {
    const bundle = new Xano()
      .register("trigger", errorTrigger({ name: "e", stack: (i) => [setVar("x1", i.signature)] }))
      .export();
    expect(bundle.payload.trigger).toHaveLength(1);
    expect((bundle.payload.trigger as any)[0].obj_type).toBe("error");
  });
});

// --- Type-level assertions (verified by `tsc --noEmit`) ---
describe("trigger database row typing (U4)", () => {
  it("insert-only: t.new is a typed accessor, t.old is null", () => {
    tableTrigger({
      name: "t",
      objId: 1,
      actions: { insert: true },
      stack: (i) => {
        void i.new("anything"); // no table handle → json floor, any string ok
        // @ts-expect-error - old is null when only insert is enabled
        void i.old("x");
        return [];
      },
    });
    expect(true).toBe(true);
  });

  it("delete-only: t.old is a typed accessor, t.new is null", () => {
    tableTrigger({
      name: "t",
      objId: 1,
      actions: { delete: true },
      stack: (i) => {
        void i.old("anything");
        // @ts-expect-error - new is null when only delete is enabled
        void i.new("x");
        return [];
      },
    });
    expect(true).toBe(true);
  });
});
