/**
 * `mixed(...)` — a condition container whose terms do not all join the same way.
 *
 * The editor allows `a AND b OR c` at one level: every row after the first
 * carries its own AND/OR choice, with nothing tying it to its siblings. So real
 * workspaces hold it, and it has to round-trip rather than degrade to `raw()`.
 *
 * It is deliberately awkward to reach for, because the stored form is ambiguous
 * by construction — see the report entry it raises and the `llms.txt` note. The
 * tests below pin the two halves that matter: the joins land exactly where the
 * editor puts them, and the SDK never silently picks a reading.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import { and, expr, mixed, or, encodeExpression } from "../../src/statements/expression.js";
import { c, inp } from "../../src/values/value.js";

const a = expr(inp("a"), "=", c.int(1));
const b = expr(inp("b"), "=", c.int(2));
const d = expr(inp("c"), "=", c.int(3));

/** The per-node join flags of an encoded container, in order. */
function joins(condition: Parameters<typeof encodeExpression>[0]): boolean[] {
  return encodeExpression(condition).expression.map((n) => (n as { or: boolean }).or);
}

describe("mixed(...)", () => {
  it("puts each term's join on that term, and never on the first", () => {
    // The first term is evaluated before any join is applied, so it always
    // stores `or:false` — there is nothing for it to join to.
    expect(joins(mixed(a, { and: b }, { or: d }))).toEqual([false, false, true]);
    expect(joins(mixed(a, { or: b }, { and: d }))).toEqual([false, true, false]);
  });

  it("flattens at the root, which is the shape the editor writes", () => {
    // Each row's own AND/OR choice lands directly on a root sibling — a root
    // `mixed(...)` must not wrap itself in a group node.
    const encoded = encodeExpression(mixed(a, { or: b }, { and: d }));
    expect(encoded.expression.map((n) => (n as { type: string }).type)).toEqual([
      "statement",
      "statement",
      "statement",
    ]);
  });

  it("nests, and keeps its own joins inside the group it sits in", () => {
    // `and(mixed(...), a)` — the outer AND wraps a root group; inside it the
    // mixed container is its own group, and its per-term joins survive intact.
    type Node = { type: string; or: boolean; group: { expression: Node[] } };
    const [root] = encodeExpression(and(mixed(a, { or: b }, { and: d }), a))
      .expression as unknown as Node[];
    expect(root!.type).toBe("group");
    const inner = root!.group.expression;
    expect(inner.map((n) => n.type)).toEqual(["group", "statement"]);
    expect(inner[0]!.group.expression.map((n) => n.or)).toEqual([false, true, false]);
  });

  it("takes groups as terms, so an explicit rewrite is expressible", () => {
    // The escape route the docs point at: `and(or(a, b), c)` says one reading in
    // every context. It stays a normal nested tree — one root group, whose
    // children carry the uniform AND join.
    type Node = { type: string; or: boolean; group: { expression: Node[] } };
    const [root] = encodeExpression(and(or(a, b), d)).expression as unknown as Node[];
    expect(root!.type).toBe("group");
    expect(root!.group.expression.map((n) => [n.type, n.or])).toEqual([
      ["group", false],
      ["statement", false],
    ]);
    // And the flat root form: an ANDed pair, the first of which is an OR group.
    expect(joins([or(a, b), d])).toEqual([false, false]);
  });

  it("is not a way to spell a uniform container", () => {
    // A mixed container whose joins happen to agree encodes identically to the
    // plain form — no hidden marker rides along, so `and()`/`or()` stay the
    // canonical spellings and a later re-pull will emit those instead.
    expect(joins(mixed(a, { and: b }, { and: d }))).toEqual(joins([a, b, d]));
    expect(joins(mixed(a, { or: b }, { or: d }))).toEqual(joins(or(a, b, d)));
  });

  it("rejects a single term, which has no join to mix", () => {
    // @ts-expect-error — the arity is enforced at the type level too.
    expect(() => mixed(a)).toThrow(/at least two terms/);
  });

  it("rejects a term that is not exactly one of `and` / `or`", () => {
    // Fail at the authoring site rather than silently defaulting to AND, which
    // would change which rows match with nothing to notice it by.
    expect(() => mixed(a, {} as never)).toThrow(/exactly one/);
    expect(() => mixed(a, { and: b, or: d } as never)).toThrow(/exactly one/);
    expect(() => mixed(a, { nor: b } as never)).toThrow(/exactly one/);
  });
});
