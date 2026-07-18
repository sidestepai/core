import { describe, it, expect } from "vitest";
import { conditional, expr } from "../src/statements/conditional.js";
import { encodeStatement } from "../src/statements/statement.js";
import { setVar } from "../src/statements/set-var.js";
import { defineFunction } from "../src/function/define.js";
import { compile } from "../src/function/compile.js";
import { input } from "../src/inputs/input.js";
import { c, inp, ref } from "../src/values/value.js";
import { normalize } from "./conformance/harness.js";

describe("conditional", () => {
  it("encodes nested run + expr to the engine shape", () => {
    const stmt = conditional({
      when: expr(inp("score"), ">", c.int(10)),
      then: [setVar("x1", c.int(1))],
      else: [setVar("x1", c.int(2))],
    });
    const encoded = encodeStatement(stmt);

    expect(encoded.name).toBe("mvp:conditional");
    expect(encoded.input).toEqual([]);

    const ctx = encoded.context as any;
    expect(ctx.expr).toEqual({
      expression: [
        {
          type: "statement",
          or: false,
          group: { expression: [] },
          statement: {
            op: ">",
            left: { operand: "score", tag: "input", filters: [] },
            right: { operand: "10", tag: "const:int", filters: [] },
          },
        },
      ],
    });
    // Nested statements carry the same full envelope; normalize compares the
    // authored fields (envelope empties dropped on both sides).
    expect(normalize(ctx.if.run)).toEqual(
      normalize([
        { name: "mvp:set_var", as: "x1", context: { value: "1", tag: "const:int", filters: [] }, input: [] },
      ]),
    );
    expect(normalize(ctx.else.run)).toEqual(
      normalize([
        { name: "mvp:set_var", as: "x1", context: { value: "2", tag: "const:int", filters: [] }, input: [] },
      ]),
    );
  });

  it("no else yields an empty else.run (engine shape)", () => {
    const stmt = conditional({ when: expr(ref("x1"), "=", c.int(3)), then: [setVar("x1", c.int(1))] });
    const ctx = encodeStatement(stmt).context as any;
    expect(ctx.else).toEqual({ run: [] });
  });

  it("an unsupported operator throws a clear error", () => {
    // @ts-expect-error - "~=" is not a supported operator
    expect(() => expr(ref("a"), "~=", c.int(1))).toThrow(/Unsupported conditional operator/);
  });

  it("JS-style operators (== === !==) normalize to the engine form", () => {
    expect(expr(ref("a"), "==", c.int(1)).op).toBe("=");
    expect(expr(ref("a"), "===", c.int(1)).op).toBe("=");
    expect(expr(ref("a"), "!==", c.int(1)).op).toBe("!=");
  });

  it("a function whose stack contains a conditional compiles end-to-end", () => {
    const fn = defineFunction({
      name: "scoreCheck",
      input: { score: input.int() },
      stack: [
        conditional({
          when: expr(inp("score"), ">", c.int(10)),
          then: [setVar("x1", c.int(1))],
          else: [setVar("x1", c.int(2))],
        }),
      ],
      response: ref("x1"),
    });
    const xdo = compile(fn);
    expect(xdo.run).toHaveLength(1);
    expect(xdo.run[0]!.name).toBe("mvp:conditional");
    const ctx = xdo.run[0]!.context as any;
    expect(ctx.if.run[0].name).toBe("mvp:set_var");
    expect(ctx.else.run[0].name).toBe("mvp:set_var");
  });
});
