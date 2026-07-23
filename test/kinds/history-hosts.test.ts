import { describe, it, expect } from "vitest";
import { encodeQuery } from "../../src/kinds/query.js";
import { encodeApiGroup } from "../../src/kinds/api-group.js";
import { encodeFunction } from "../../src/kinds/function.js";
import { encodeTask } from "../../src/kinds/task.js";
import { encodeTool } from "../../src/kinds/toolset.js";
import { encodeAgent } from "../../src/kinds/agent.js";
import { defineFunction } from "../../src/function/define.js";
import { setVar } from "../../src/statements/set-var.js";
import { c } from "../../src/values/value.js";

const stack = [setVar("x1", c.int(1))];

describe("history authoring — object-tier hosts", () => {
  it("query: default inherits; a scalar flips inherit off", () => {
    expect(encodeQuery({ name: "q", verb: "GET", stack }).history).toEqual({
      inherit: true,
      enabled: true,
      limit: 100,
    });
    expect(encodeQuery({ name: "q", verb: "GET", stack, history: 500 }).history).toEqual({
      inherit: false,
      enabled: true,
      limit: 500,
    });
    expect(encodeQuery({ name: "q", verb: "GET", stack, history: false }).history).toEqual({
      inherit: false,
      enabled: false,
      limit: 100,
    });
  });

  it("function: OFF-by-default preserved; true enables it", () => {
    expect(encodeFunction(defineFunction({ name: "f", stack })).history).toEqual({
      inherit: true,
      enabled: false,
      limit: 100,
    });
    expect(encodeFunction(defineFunction({ name: "f", stack, history: true })).history).toEqual({
      inherit: false,
      enabled: true,
      limit: 100,
    });
  });

  it("task: default ON inherit; number sets depth", () => {
    expect(encodeTask({ name: "t", stack }).history).toEqual({
      inherit: true,
      enabled: true,
      limit: 100,
    });
    expect(encodeTask({ name: "t", stack, history: 10 }).history).toEqual({
      inherit: false,
      enabled: true,
      limit: 10,
    });
  });

  it('tool: "all" → unlimited depth', () => {
    expect(encodeTool({ name: "tl", stack, history: "all" }).history).toEqual({
      inherit: false,
      enabled: true,
      limit: -1,
    });
    // default path unchanged
    expect(encodeTool({ name: "tl", stack }).history).toEqual({
      inherit: true,
      enabled: true,
      limit: 100,
    });
  });
});

describe("history authoring — container-tier hosts", () => {
  it("api group: omitted → hardcoded default (byte-parity); authored → query_*", () => {
    expect(encodeApiGroup({ name: "g" }).history).toEqual({
      inherit: true,
      query_enabled: true,
      query_limit: 100,
    });
    expect(encodeApiGroup({ name: "g", history: false }).history).toEqual({
      inherit: false,
      query_enabled: false,
      query_limit: 100,
    });
  });

  it("toolset envelope (agent): omitted → inherit default that normalizes away; authored → tool_*", () => {
    const llm = { type: "xano-free", systemPrompt: "hi", maxSteps: 5, prompt: "hi" } as const;
    expect(encodeAgent({ name: "a", llm }).history).toEqual({
      inherit: true,
      tool_enabled: true,
      tool_limit: 100,
    });
    expect(encodeAgent({ name: "a", llm, history: 250 }).history).toEqual({
      inherit: false,
      tool_enabled: true,
      tool_limit: 250,
    });
  });
});
