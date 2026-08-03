import { describe, it, expect } from "vitest";
import { encodeFunction, functionKind } from "../../src/kinds/function.js";
import { compile } from "../../src/function/compile.js";
import { defineFunction } from "../../src/function/define.js";
import { setVar } from "../../src/statements/set-var.js";
import { c, ref } from "../../src/values/value.js";

const sample = defineFunction({
  name: "f",
  stack: [setVar("x1", c.int(1))],
  response: ref("x1"),
});

describe("function kind", () => {
  it("encodeFunction matches the compile() façade (no behavior change)", () => {
    expect(encodeFunction(sample)).toEqual(compile(sample));
  });

  it("declares the right kind metadata", () => {
    expect(functionKind.name).toBe("function");
    expect(functionKind.payloadKey).toBe("function");
    expect(functionKind.encode(sample)).toEqual(compile(sample));
  });

  it("throws when name is missing", () => {
    // @ts-expect-error - intentionally omitting required name
    expect(() => encodeFunction({ stack: [] })).toThrow(/name/);
  });

  it("carries an authored cache block, and defaults it when absent", () => {
    // The engine reads a function's `cache` through the same runtime path as a
    // query's. The encoder used to hard-code the default, so a pulled function
    // with caching switched ON re-exported with it OFF — a redeploy silently
    // turned real caching off.
    expect(encodeFunction({ name: "f" }).cache).toEqual({
      active: false, ttl: 3600, input: true, auth: true, datasource: true, ip: false,
      headers: [], env: [],
    });
    const cached = encodeFunction({
      name: "f",
      cache: { active: true, ttl: 60, ip: true, headers: ["x-tenant"], env: ["REGION"] },
    });
    expect(cached.cache).toMatchObject({
      active: true, ttl: 60, ip: true, headers: ["x-tenant"], env: ["REGION"],
    });
  });
});
