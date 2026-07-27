import { describe, it, expect } from "vitest";
import {
  encodeWorkspaceConfig,
  encodeWorkspaceEnv,
} from "../../src/kinds/workspace-config.js";

describe("encodeWorkspaceEnv", () => {
  it("maps a name→value map to the engine env[] array in declared order", () => {
    expect(encodeWorkspaceEnv({ A: "1", B: "2" })).toEqual([
      { name: "A", value: "1", market_item: [] },
      { name: "B", value: "2", market_item: [] },
    ]);
  });

  it("preserves insertion order across 3+ keys", () => {
    const out = encodeWorkspaceEnv({ Z: "z", A: "a", M: "m" });
    expect(out.map((e) => e.name)).toEqual(["Z", "A", "M"]);
  });

  it("passes values through verbatim (URLs, special chars)", () => {
    const value = "https://app.example.com/path?a=1&b=</script>";
    expect(encodeWorkspaceEnv({ APP_URL: value })).toEqual([
      { name: "APP_URL", value, market_item: [] },
    ]);
  });
});

describe("encodeWorkspaceConfig env", () => {
  it("encodes an authored env map to the array shape", () => {
    const xdo = encodeWorkspaceConfig({ name: "ws", env: { A: "1", B: "2" } });
    expect(xdo.env).toEqual([
      { name: "A", value: "1", market_item: [] },
      { name: "B", value: "2", market_item: [] },
    ]);
  });

  it("absent env emits [] (engine full-export default), never {}", () => {
    expect(encodeWorkspaceConfig({ name: "ws" }).env).toEqual([]);
  });

  it("empty env map emits []", () => {
    expect(encodeWorkspaceConfig({ name: "ws", env: {} }).env).toEqual([]);
  });

  it("emits a value sourced from process.env verbatim", () => {
    process.env.SIDESTEP_TEST_ENV_VALUE = "rt_value";
    try {
      const xdo = encodeWorkspaceConfig({
        name: "ws",
        env: { RT_KEY: process.env.SIDESTEP_TEST_ENV_VALUE! },
      });
      expect(xdo.env).toEqual([{ name: "RT_KEY", value: "rt_value", market_item: [] }]);
    } finally {
      delete process.env.SIDESTEP_TEST_ENV_VALUE;
    }
  });

  it("encodes env alongside middleware and history without disturbing them", () => {
    const xdo = encodeWorkspaceConfig({
      name: "ws",
      env: { A: "1" },
      history: { query: 100 },
      middleware: { query: { pre: [] } },
    });
    expect(xdo.env).toEqual([{ name: "A", value: "1", market_item: [] }]);
    expect(xdo.history).toBeDefined();
    expect(xdo.middleware).toBeDefined();
  });
});
