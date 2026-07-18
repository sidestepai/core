import { describe, it, expect } from "vitest";
import { tool, encodeTool, encodeToolset, toolset, agent } from "../../src/kinds/toolset.js";
import { Xano } from "../../src/workspace/xano.js";
import { input } from "../../src/inputs/input.js";
import { setVar } from "../../src/statements/set-var.js";
import { c, ref } from "../../src/values/value.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { normalize, loadFixture } from "../conformance/harness.js";

describe("tool kind", () => {
  it("encodes a function-like tool envelope", () => {
    const t = encodeTool({
      name: "test_tool",
      instructions: "do a thing",
      input: { score: input.int() },
      stack: [setVar("x1", c.int(123))],
      response: ref("x1"),
      tags: ["test", "ok"],
    });
    expect(t.name).toBe("test_tool");
    expect(t.instructions).toBe("do a thing");
    expect(t.toolset).toEqual({ id: 0 });
    expect(t.middleware).toEqual({ pre_customize: false, post_customize: false, pre: [], post: [] });
    expect(t.tag).toEqual([{ tag: "test" }, { tag: "ok" }]);
    expect(t.result).toEqual([
      { filters: [], name: "", tag: "var", value: "x1", _xsid: "", disabled: false },
    ]);
    expect(t.run).toHaveLength(1);
    expect(t.test).toEqual([]);
  });

  it("tool input[] reuses the full persisted field shape (matches fixture input)", () => {
    const fixture = loadFixture<{ input: unknown[] }>("toolset/tool.json");
    const t = encodeTool({ name: "x", input: { score: input.int() } });
    // The fixture's first input is `score:int`; compare field shapes (minus _xsid).
    expect(normalize(t.input[0])).toEqual(normalize(fixture.input[0]));
  });

  it("requires a name", () => {
    // @ts-expect-error - missing name
    expect(() => encodeTool({})).toThrow(/name/);
  });

  it("tool() factory passes the def through to encoding", () => {
    const def = tool({ name: "demo", instructions: "x" });
    expect(def).toEqual({ name: "demo", instructions: "x" });
    expect(encodeTool(def).name).toBe("demo");
  });
});

describe("toolset kind — AI vs MCP", () => {
  it("MCP toolset: type 'mcp', tool refs, no agent_settings", () => {
    const ts = encodeToolset(toolset.mcp({ name: "books", tools: [{ id: 1 }, { id: 2, enabled: false }] }));
    expect(ts.type).toBe("mcp");
    expect(ts.tool).toEqual([
      { id: 1, enabled: true, auth: null },
      { id: 2, enabled: false, auth: null },
    ]);
    expect(ts.agent_settings).toBeUndefined();
  });

  it("tool ref by handle resolves to the tool's guid (like the call family)", () => {
    const myTool = tool({ name: "search" });
    const ts = encodeToolset(toolset.mcp({ name: "books", tools: [{ tool: myTool }, { tool: "lookup" }] }));
    expect(ts.tool).toEqual([
      { id: deriveGuid("tool", "search"), enabled: true, auth: null },
      { id: deriveGuid("tool", "lookup"), enabled: true, auth: null },
    ]);
  });

  it("tool ref rejects setting both `tool` and `id`", () => {
    expect(() =>
      encodeToolset(toolset.mcp({ name: "books", tools: [{ tool: "x", id: 1 }] })),
    ).toThrow(/either `tool`.*or `id`/);
  });

  it("agent toolset: type 'agent', carries agent_settings", () => {
    const ts = encodeToolset(
      agent({
        name: "assistant",
        agentSettings: { type: "anthropic", model: "claude-opus-4-8", system_prompt: "be helpful", max_steps: 5 },
        tools: [{ id: 3 }],
      }),
    );
    expect(ts.type).toBe("agent");
    expect(ts.agent_settings).toEqual({
      type: "anthropic",
      model: "claude-opus-4-8",
      system_prompt: "be helpful",
      max_steps: 5,
    });
    expect(ts.tool).toEqual([{ id: 3, enabled: true, auth: null }]);
  });

  it("registers tool and toolset on Xano under their payload keys", () => {
    const bundle = new Xano()
      .register("tool", encodeToolReadyDef())
      .register("toolset", toolset.mcp({ name: "books", tools: [{ id: 1 }] }))
      .export();
    expect(bundle.payload.tool).toHaveLength(1);
    expect(bundle.payload.toolset).toHaveLength(1);
    expect((bundle.payload.toolset as any)[0].type).toBe("mcp");
  });
});

function encodeToolReadyDef() {
  return { name: "t", stack: [setVar("x1", c.int(1))], response: ref("x1") };
}
