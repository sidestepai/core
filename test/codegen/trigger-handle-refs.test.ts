/**
 * U3 — `inp("<implied>")` → the typed trigger handle.
 *
 * A trigger's inputs are fixed by `obj_type`, so the factories hand the stack a
 * typed handle `t` instead of making authors guess input names. The decoded stack
 * arrives referencing those inputs as raw strings; this transform is what turns
 * them back into handle access so a pulled trigger keeps its row typing.
 *
 * The handle member is CALLABLE, not a property bag —
 * `t.new("id")` is `inp("new.id")`, not `t.new.id` — so the rewrite targets a
 * call, not a member expression. See `src/kinds/trigger-handle.ts`.
 */
import { describe, it, expect } from "vitest";
import { arr, call, id, lit, obj, spread, printExpr, type Expr } from "../../src/codegen/print.js";
import { rewriteTriggerInputRefs } from "../../src/codegen/kinds/trigger-handle-refs.js";

/** Rewrite and print, so assertions read as the source a pull would emit. */
const src = (node: Expr, objType = "database" as const) =>
  printExpr(rewriteTriggerInputRefs(node, objType));

describe("rewriteTriggerInputRefs — the reference forms", () => {
  it("rewrites a whole-input reference to the bare handle member", () => {
    expect(src(call("inp", lit("new")))).toBe("t.new");
    expect(src(call("inp", lit("action")))).toBe("t.action");
  });

  it("rewrites a child reference to a handle call", () => {
    expect(src(call("inp", lit("new.id")))).toBe('t.new("id")');
  });

  it("keeps a deep path whole rather than chaining calls", () => {
    // `FieldAccessor` accepts `${K}.${string}`, so the tail stays one argument.
    expect(src(call("inp", lit("new.a.b")))).toBe('t.new("a.b")');
  });

  it("leaves an input name that is not implied for this obj_type alone", () => {
    // `payload` is a realtime input; a database trigger has no such member, so
    // rewriting it would emit `t.payload` against a handle that lacks it.
    expect(src(call("inp", lit("payload")))).toBe('inp("payload")');
    expect(src(call("inp", lit("payload.body")))).toBe('inp("payload.body")');
  });

  it("does not rewrite a name that merely starts with an implied name", () => {
    // `newest` is not `new`. Splitting on the first dot, not on prefix, is why.
    expect(src(call("inp", lit("newest")))).toBe('inp("newest")');
    expect(src(call("inp", lit("newest.id")))).toBe('inp("newest.id")');
  });

  it("leaves a non-literal or multi-argument inp() call untouched", () => {
    expect(src(call("inp"))).toBe("inp()");
    expect(src(call("inp", id("dynamic")))).toBe("inp(dynamic)");
  });
});

describe("rewriteTriggerInputRefs — where references hide", () => {
  it("rewrites inside array items, object values, and call arguments", () => {
    const node = arr([
      obj([["fieldValue", call("inp", lit("new.id"))]]),
      call("withFilters", call("inp", lit("old.email")), lit("trim")),
    ]);
    const out = src(node);
    expect(out).toContain('fieldValue: t.new("id")');
    expect(out).toContain('withFilters(t.old("email"), "trim")');
    expect(out).not.toContain("inp(");
  });

  it("rewrites inside a spread node's base and its entries", () => {
    // The envelope-passthrough escape hatch wraps a factory result in a spread;
    // a reference can sit on either side of it.
    const node = spread(call("inp", lit("new")), [["description", call("inp", lit("old.note"))]]);
    const out = src(node);
    expect(out).toContain("...t.new,");
    expect(out).toContain('description: t.old("note")');
  });

  it("returns a tree with no inp() call structurally unchanged", () => {
    const node = obj([["as", lit("row")], ["table", id("user")], ["data", arr([lit(1)])]]);
    expect(src(node)).toBe(printExpr(node));
  });

  it("leaves a literal that merely contains the text `inp` alone", () => {
    expect(src(lit({ note: 'inp("new.id")' }))).toContain('inp(\\"new.id\\")');
  });
});

describe("rewriteTriggerInputRefs — per obj_type membership", () => {
  const CASES = [
    ["database", "new", "payload"],
    ["workspace", "to_branch", "new"],
    ["error", "signature", "new"],
    ["toolset", "toolset", "new"],
    ["realtime_server", "client", "new"],
    ["channel", "channel", "new"],
    ["workspace_realtime_channel", "payload", "new"],
  ] as const;

  for (const [objType, own, foreign] of CASES) {
    it(`${objType} rewrites its own \`${own}\` and leaves \`${foreign}\``, () => {
      expect(src(call("inp", lit(own)), objType as never)).toBe(`t.${own}`);
      expect(src(call("inp", lit(foreign)), objType as never)).toBe(`inp("${foreign}")`);
    });
  }
});
