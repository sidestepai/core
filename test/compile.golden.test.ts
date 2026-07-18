import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineFunction } from "../src/function/define.js";
import { compile, encodeResponse } from "../src/function/compile.js";
import { input } from "../src/inputs/input.js";
import { setVar } from "../src/statements/set-var.js";
import { c, ref } from "../src/values/value.js";
import { normalize } from "./helpers/normalize.js";

const goldenPath = fileURLToPath(
  new URL("./fixtures/golden-set-var-function.json", import.meta.url),
);
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));

describe("compile() golden-fixture parity (U6 — the load-bearing proof)", () => {
  it("the authored fixture function deep-equals the real engine fixture after normalization", () => {
    const fn = defineFunction({
      name: "input-test",
      input: {
        name: input.text({ required: false, methods: ["trim"] }),
        score: input.int({ required: false }),
      },
      stack: [setVar("x1", c.int(123))],
      response: ref("x1"),
    });

    expect(normalize(compile(fn))).toEqual(normalize(golden));
  });
});

describe("compile() response mapping", () => {
  it("a single Value response produces a one-item result with name:''", () => {
    const fn = defineFunction({ name: "f", stack: [setVar("x1", c.int(1))], response: ref("x1") });
    expect(compile(fn).result).toEqual([
      { filters: [], name: "", tag: "var", value: "x1", _xsid: "", disabled: false },
    ]);
  });

  it("a record response produces one named item per key", () => {
    const result = encodeResponse({ data: ref("x1"), status: c.text("ok") });
    expect(result).toEqual([
      { filters: [], name: "data", tag: "var", value: "x1", _xsid: "", disabled: false },
      { filters: [], name: "status", tag: "const", value: "ok", _xsid: "", disabled: false },
    ]);
  });

  it("an undefined response produces an empty result", () => {
    expect(encodeResponse(undefined)).toEqual([]);
  });
});

describe("compile() envelope + validation", () => {
  it("an empty stack compiles to run:[] with a valid envelope", () => {
    const xdo = compile(defineFunction({ name: "empty" }));
    expect(xdo.run).toEqual([]);
    expect(xdo.cache.ttl).toBe(3600);
    expect(xdo.history).toEqual({ inherit: true, enabled: false, limit: 100 });
    expect(xdo.middleware).toEqual({
      pre_customize: false,
      post_customize: false,
      pre: [],
      post: [],
    });
  });

  it("defineFunction throws when name is missing", () => {
    // @ts-expect-error - intentionally omitting required name
    expect(() => defineFunction({ stack: [] })).toThrow(/name/);
  });

  it("workspace id defaults to 0 and can be overridden", () => {
    expect(compile(defineFunction({ name: "f" })).workspace).toEqual({ id: 0 });
    expect(compile(defineFunction({ name: "f", workspace: 7 })).workspace).toEqual({ id: 7 });
  });
});
