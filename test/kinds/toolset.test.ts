import { describe, it, expect } from "vitest";
import { tool, encodeTool, encodeToolsetBase, encodeToolRefs } from "../../src/kinds/toolset.js";
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

describe("shared toolset base (encodeToolsetBase / encodeToolRefs)", () => {
  it("builds the common envelope with the inert empty middleware skeleton", () => {
    const base = encodeToolsetBase({ name: "books", description: "d", instructions: "i", canonical: "cX" });
    expect(base.name).toBe("books");
    expect(base.description).toBe("d");
    expect(base.instructions).toBe("i");
    expect(base.canonical).toBe("cX");
    // Toolset-level middleware is not an engine feature — always the empty block.
    expect(base.middleware).toEqual({ pre_customize: false, post_customize: false, pre: [], post: [] });
    expect(base.tool).toEqual([]);
  });

  it("tool refs: raw id passes through; enabled defaults true", () => {
    expect(encodeToolRefs([{ id: 1 }, { id: 2, enabled: false }])).toEqual([
      { id: 1, enabled: true, auth: false },
      { id: 2, enabled: false, auth: false },
    ]);
  });

  it("tool ref by handle resolves to the tool's guid (like the call family)", () => {
    const myTool = tool({ name: "search" });
    expect(encodeToolRefs([{ tool: myTool }, { tool: "lookup" }])).toEqual([
      { id: deriveGuid("tool", "search"), enabled: true, auth: false },
      { id: deriveGuid("tool", "lookup"), enabled: true, auth: false },
    ]);
  });

  it("tool ref rejects setting both `tool` and `id`", () => {
    expect(() => encodeToolRefs([{ tool: "x", id: 1 }])).toThrow(/either `tool`.*or `id`/);
  });
});
