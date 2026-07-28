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

/**
 * The four `?=`-optional workspace blocks (`use_custom_names`, `defaults`,
 * `datasources`, `datasource_live`) are real authorable config the engine
 * persists but `WorkspaceConfigDef` did not model, so a pulled workspace could
 * not re-export them.
 *
 * They are encoded **by presence**, not by comparing against a default. That
 * distinction is the whole point: the engine's schema gives each a `?=` default,
 * so "absent" and "present, equal to the default" are different stored bytes.
 * Eliding on value would collapse the two and only one shape would round-trip.
 */
describe("encodeWorkspaceConfig — presence-preserving optional blocks", () => {
  it("omits every optional block a workspace does not declare", () => {
    const xdo = encodeWorkspaceConfig({ name: "ws" });
    expect(Object.hasOwn(xdo, "use_custom_names")).toBe(false);
    expect(Object.hasOwn(xdo, "defaults")).toBe(false);
    expect(Object.hasOwn(xdo, "datasources")).toBe(false);
    expect(Object.hasOwn(xdo, "datasource_live")).toBe(false);
  });

  it("emits a block set to its engine default, rather than eliding it", () => {
    // `db_primary_key` defaults to "int" in the engine schema. An author who
    // writes it explicitly must still get the key in the bundle, or their
    // workspace stops matching the bytes it was pulled from.
    const xdo = encodeWorkspaceConfig({ name: "ws", defaults: { db_primary_key: "int" } });
    expect(xdo.defaults).toEqual({ db_primary_key: "int" });
  });

  it("emits use_custom_names when set to false, which is also its default", () => {
    const xdo = encodeWorkspaceConfig({ name: "ws", use_custom_names: false });
    expect(xdo.use_custom_names).toBe(false);
  });

  it("carries datasources in declared order, preserving each entry's own optionals", () => {
    const xdo = encodeWorkspaceConfig({
      name: "ws",
      datasources: [{ label: "test", color: "#fff3cd" }, { label: "staging" }],
    });
    expect(xdo.datasources).toEqual([{ label: "test", color: "#fff3cd" }, { label: "staging" }]);
  });

  it("copies nested blocks rather than aliasing the author's object", () => {
    // The def is user-owned; mutating the encoded bundle must not reach back
    // into it (and a second encode of the same def must produce the same bytes).
    const def = { name: "ws", datasource_live: { color: "#008000", show_banner: false } };
    const xdo = encodeWorkspaceConfig(def);
    expect(xdo.datasource_live).not.toBe(def.datasource_live);
    expect(xdo.datasource_live).toEqual({ color: "#008000", show_banner: false });
  });

  it("leaves the modeled non-optional keys alone", () => {
    const xdo = encodeWorkspaceConfig({ name: "ws", use_custom_names: true });
    expect(xdo.name).toBe("ws");
    expect(xdo.env).toEqual([]);
    expect(xdo.settings).toEqual({});
  });
});
