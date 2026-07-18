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
});
