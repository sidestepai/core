import { describe, it, expect } from "vitest";
import { encodeFunction } from "../../src/kinds/function.js";
import { encodeTask } from "../../src/kinds/task.js";
import { encodeTool } from "../../src/kinds/toolset.js";
import { encodeMcpServer } from "../../src/kinds/mcp-server.js";
import { resolveRef } from "../../src/refs/guid.js";

const EMPTY = { pre_customize: false, post_customize: false, pre: [], post: [] };

describe("function middleware attachment", () => {
  it("defaults to the empty block", () => {
    expect(encodeFunction({ name: "f" }).middleware).toEqual(EMPTY);
  });
  it("attaches a pre chain", () => {
    const fn = encodeFunction({ name: "f", middleware: { pre: ["guard"] } });
    expect(fn.middleware.pre_customize).toBe(true);
    expect((fn.middleware.pre[0] as { context: { middleware: { id: string } } }).context.middleware.id).toBe(
      resolveRef("middleware", "guard"),
    );
  });
  it("post:[] is an explicit override-with-nothing", () => {
    const fn = encodeFunction({ name: "f", middleware: { post: [] } });
    expect(fn.middleware.post_customize).toBe(true);
    expect(fn.middleware.post).toEqual([]);
  });
});

describe("task middleware attachment", () => {
  it("defaults to the empty block", () => {
    expect(encodeTask({ name: "t" }).middleware).toEqual(EMPTY);
  });
  it("attaches a post chain in order", () => {
    const t = encodeTask({ name: "t", middleware: { post: ["a", "b"] } });
    const ids = (t.middleware.post as Array<{ context: { middleware: { id: string } } }>).map(
      (e) => e.context.middleware.id,
    );
    expect(ids).toEqual([resolveRef("middleware", "a"), resolveRef("middleware", "b")]);
  });
});

describe("tool middleware attachment", () => {
  it("defaults to the empty block", () => {
    expect(encodeTool({ name: "tl" }).middleware).toEqual(EMPTY);
  });
  it("attaches on the tool, not the toolset envelope", () => {
    const tool = encodeTool({ name: "tl", middleware: { pre: ["auth"] } });
    expect(tool.middleware.pre_customize).toBe(true);
    // The toolset envelope stays empty — tools are the host, not the toolset
    // (verified: the engine runs middleware per-tool, never per-toolset).
    const ts = encodeMcpServer({ name: "ts" });
    expect(ts.middleware).toEqual(EMPTY);
  });
  it("marks a disabled attachment entry", () => {
    const tool = encodeTool({ name: "tl", middleware: { pre: [{ middleware: "auth", active: false }] } });
    expect((tool.middleware.pre[0] as { disabled: boolean }).disabled).toBe(true);
  });
});
