import { describe, it, expect } from "vitest";
import {
  encodeHistory,
  encodeContainerHistory,
  buildWorkspaceHistory,
  WORKSPACE_HISTORY_TYPES,
} from "../../src/kinds/history.js";

describe("encodeHistory (object tier)", () => {
  it("omitted → inherit default, per-kind enabled preserved", () => {
    expect(encodeHistory("query")).toEqual({ inherit: true, enabled: true, limit: 100 });
    expect(encodeHistory("task")).toEqual({ inherit: true, enabled: true, limit: 100 });
    expect(encodeHistory("tool")).toEqual({ inherit: true, enabled: true, limit: 100 });
    expect(encodeHistory("function")).toEqual({ inherit: true, enabled: false, limit: 100 });
    expect(encodeHistory("middleware")).toEqual({ inherit: true, enabled: false, limit: 100 });
    expect(encodeHistory("trigger")).toEqual({ inherit: true, enabled: false, limit: 100 });
  });

  it("false → disabled, inherit flipped off", () => {
    expect(encodeHistory("query", false)).toEqual({ inherit: false, enabled: false, limit: 100 });
  });

  it("true → enabled at default depth, inherit off", () => {
    expect(encodeHistory("function", true)).toEqual({ inherit: false, enabled: true, limit: 100 });
  });

  it("number → enabled with that capture depth", () => {
    expect(encodeHistory("query", 250)).toEqual({ inherit: false, enabled: true, limit: 250 });
    expect(encodeHistory("query", 0)).toEqual({ inherit: false, enabled: true, limit: 0 });
  });

  it('"all" → unlimited depth (-1)', () => {
    expect(encodeHistory("query", "all")).toEqual({ inherit: false, enabled: true, limit: -1 });
  });

  it("rejects negative or non-integer numeric limits", () => {
    expect(() => encodeHistory("query", -5)).toThrow(/non-negative integer/);
    expect(() => encodeHistory("query", 1.5)).toThrow(/non-negative integer/);
  });
});

describe("encodeContainerHistory (container tier)", () => {
  it("api group (query_*) omitted → inherit default, byte-identical to prior hardcode", () => {
    expect(encodeContainerHistory("query")).toEqual({
      inherit: true,
      query_enabled: true,
      query_limit: 100,
    });
  });

  it("toolset (tool_*) omitted → inherit default", () => {
    expect(encodeContainerHistory("tool")).toEqual({
      inherit: true,
      tool_enabled: true,
      tool_limit: 100,
    });
  });

  it("authored values flip inherit off with prefixed keys", () => {
    expect(encodeContainerHistory("query", false)).toEqual({
      inherit: false,
      query_enabled: false,
      query_limit: 100,
    });
    expect(encodeContainerHistory("tool", 100)).toEqual({
      inherit: false,
      tool_enabled: true,
      tool_limit: 100,
    });
    expect(encodeContainerHistory("query", "all")).toEqual({
      inherit: false,
      query_enabled: true,
      query_limit: -1,
    });
  });

  it("emits disjoint key sets — no bare enabled/limit leak", () => {
    const block = encodeContainerHistory("query", 100) as Record<string, unknown>;
    expect(block).not.toHaveProperty("enabled");
    expect(block).not.toHaveProperty("limit");
    expect(block).not.toHaveProperty("tool_enabled");
  });
});

describe("buildWorkspaceHistory (workspace tier)", () => {
  it("empty map → all 14 keys at engine defaults, no inherit (matches golden)", () => {
    expect(buildWorkspaceHistory({})).toEqual({
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
  });

  it("no inherit key at the terminal tier", () => {
    expect(buildWorkspaceHistory({ query: 100 })).not.toHaveProperty("inherit");
  });

  it("listed types override; omitted types stay at defaults (wholesale)", () => {
    const m = buildWorkspaceHistory({ query: 100, function: true, trigger: "all" });
    expect(m.query_enabled).toBe(true);
    expect(m.query_limit).toBe(100);
    expect(m.function_enabled).toBe(true);
    expect(m.function_limit).toBe(100);
    expect(m.trigger_enabled).toBe(true);
    expect(m.trigger_limit).toBe(-1);
    // untouched types keep engine defaults
    expect(m.task_enabled).toBe(true);
    expect(m.middleware_enabled).toBe(false);
    expect(m.middleware_limit).toBe(100);
  });

  it("emits exactly the 12 stored keys", () => {
    const keys = Object.keys(buildWorkspaceHistory({})).sort();
    const expected = WORKSPACE_HISTORY_TYPES.flatMap((t) => [`${t}_enabled`, `${t}_limit`]).sort();
    expect(keys).toEqual(expected);
    expect(keys).not.toContain("test_enabled");
  });
});
