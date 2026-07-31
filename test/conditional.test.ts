import { describe, it, expect } from "vitest";
import { conditional, conditionalElif, expr, cmp, and, or } from "../src/statements/conditional.js";
import { encodeStatement } from "../src/statements/statement.js";
import { setVar } from "../src/statements/set-var.js";
import { defineFunction } from "../src/function/define.js";
import { compile } from "../src/function/compile.js";
import { input } from "../src/inputs/input.js";
import { c, inp, ref, withFilters, filter } from "../src/values/value.js";
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

  it("normalizes == to =, the one JS spelling that IS a synonym", () => {
    // The engine's evaluator runs both through the same loose branch
    // (`case '=': case '==':`), so this rewrite changes nothing.
    expect(expr(ref("a"), "==", c.int(1)).op).toBe("=");
  });

  it("keeps === and !== STRICT instead of downgrading them to = and !=", () => {
    // They are not spellings of the loose pair. The engine evaluates them with
    // PHP semantics — `$l === $r` vs `$l == $r` — so they differ exactly where
    // type coercion does: `"1" == 1` holds, `"1" === 1` does not. Aliasing them
    // onto `=`/`!=` silently downgraded every strict comparison an author wrote,
    // and rewrote a pulled one into a DIFFERENT predicate.
    expect(expr(ref("a"), "===", c.int(1)).op).toBe("===");
    expect(expr(ref("a"), "!==", c.int(1)).op).toBe("!==");
  });

  it("a bare single expr() emits byte-identical output after the tree widening (regression)", () => {
    // R2 guard: the common single-comparison case must not change bytes.
    const ctx = encodeStatement(
      conditional({ when: expr(inp("score"), ">", c.int(10)), then: [setVar("x1", c.int(1))] }),
    ).context as any;
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
  });

  it("a grouped AND/OR condition (cmp + and/or) encodes nested {type:'group'} nodes", () => {
    const ctx = encodeStatement(
      conditional({
        when: and(
          cmp(ref("status"), "like", c.text("%active%")),
          or(expr(ref("n"), ">", c.int(0)), expr(ref("n"), "<", c.int(-10))),
        ),
        then: [setVar("hit", c.text("yes"))],
      }),
    ).context as any;
    const top = ctx.expr.expression;
    // `when: and(...)` → a single top-level group node.
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe("group");
    const inner = top[0].group.expression;
    expect(inner[0].statement.op).toBe("like"); // full operator set via cmp()
    expect(inner[1].type).toBe("group"); // the nested or(...)
    // OR semantics: first child or:false, second or:true.
    expect(inner[1].group.expression[0].or).toBe(false);
    expect(inner[1].group.expression[1].or).toBe(true);
  });

  it("a filtered operand passes through inline in a condition (conditionals accept it; no #118)", () => {
    const ctx = encodeStatement(
      conditional({
        when: expr(withFilters(ref("nums"), filter("count")), ">", c.int(0)),
        then: [setVar("ok", c.text("yes"))],
      }),
    ).context as any;
    expect(ctx.expr.expression[0].statement.left).toEqual({
      operand: "nums",
      tag: "var",
      filters: [{ name: "count", disabled: false, arg: [] }],
    });
  });

  it("a plain conditional emits an empty elif stack (engine always persists elif.run)", () => {
    const stmt = conditional({ when: expr(ref("x1"), "=", c.int(3)), then: [setVar("x1", c.int(1))] });
    const ctx = encodeStatement(stmt).context as any;
    expect(ctx.elif).toEqual({ run: [] });
  });

  it("an elif chain encodes an ordered stack of mvp:conditional_elif branches", () => {
    const stmt = conditional({
      when: expr(ref("n"), ">", c.int(10)),
      then: [setVar("b", c.text("high"))],
      elif: [
        { when: expr(ref("n"), ">", c.int(3)), then: [setVar("b", c.text("mid"))] },
        { when: expr(ref("n"), ">", c.int(0)), then: [setVar("b", c.text("low"))] },
      ],
      else: [setVar("b", c.text("none"))],
    });
    const ctx = encodeStatement(stmt).context as any;
    expect(ctx.elif.run).toHaveLength(2);
    expect(ctx.elif.run.map((s: any) => s.name)).toEqual(["mvp:conditional_elif", "mvp:conditional_elif"]);
    // Author order preserved; each branch carries its own expr + if.run.
    expect(ctx.elif.run[0].context.expr.expression[0].statement.right.operand).toBe("3");
    expect(ctx.elif.run[1].context.expr.expression[0].statement.right.operand).toBe("0");
    expect(ctx.elif.run[0].context.if.run[0].name).toBe("mvp:set_var");
    // A conditional_elif is a leaf: no else / no nested elif.
    expect(ctx.elif.run[0].context.else).toBeUndefined();
    expect(ctx.elif.run[0].context.elif).toBeUndefined();
  });

  it("conditionalElif encodes a single leaf branch (expr + if.run only)", () => {
    const stmt = conditionalElif({ when: expr(ref("n"), ">", c.int(3)), then: [setVar("b", c.text("mid"))] });
    const encoded = encodeStatement(stmt);
    expect(encoded.name).toBe("mvp:conditional_elif");
    expect(Object.keys(encoded.context as object).sort()).toEqual(["expr", "if"]);
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
