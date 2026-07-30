/**
 * What a `raw()` fallback SAYS about itself.
 *
 * Every fallback reported "<name> has no decoder". That is false whenever a
 * decoder exists and merely declined — 81 of 181 rows in a 187-workspace sweep
 * said it of `mvp:dbo_view`, `mvp:conditional` and `mvp:set_var`, all of which
 * have had decoders for a long time. Read literally it sends a maintainer to
 * write code that is already there.
 *
 * The two causes need different work, so the report names which one it is: a
 * statement nothing models is a COVERAGE gap, one whose decoder declined is a
 * FIDELITY gap inside a decoder that exists.
 */
import { describe, it, expect } from "vitest";
import { decodeStack } from "../../src/codegen/statement.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { printExpr } from "../../src/codegen/print.js";
import { deriveGuid } from "../../src/refs/guid.js";
import "../../src/index.js";

function fallbackDetail(stored: Record<string, unknown>): string {
  const ctx = new DecodeContext();
  decodeStack(ctx, new RefIndex(), [stored as never], {} as never);
  const entry = ctx.report.entries.find((e) => e.category === "raw-fallback");
  return entry?.detail ?? "";
}

describe("raw() fallback reporting", () => {
  it("says a statement nothing models has no decoder", () => {
    const detail = fallbackDetail({ name: "mvp:not_a_real_statement", context: {} });
    expect(detail).toContain("has no decoder");
  });

  it("does NOT claim a modelled statement has no decoder", () => {
    // `mvp:dbo_view` is modelled. Whatever stops this one decoding, "no decoder"
    // is the wrong sentence — and the one that wasted maintainer time.
    const detail = fallbackDetail({ name: "mvp:dbo_view", context: {} });
    expect(detail).not.toContain("has no decoder");
    expect(detail).toContain("is modelled");
    expect(detail).toContain("could not reproduce");
  });
});

/**
 * `security.create_auth_token` against an UNBOUND auth table.
 *
 * The table guid is stored as a bare `const` input, and a blank one made
 * `resolveRef` throw inside the factory — which is not a local failure, it took
 * the whole statement to `raw()`. 5 of the remaining factory aborts in a
 * 187-workspace sweep were this.
 */
describe("create_auth_token with an unbound table", () => {
  const stored = (guid: string) => ({
    name: "mvp:create_auth",
    as: "token",
    context: {},
    input: [
      { name: "id", tag: "auth", value: "id", filters: [] },
      { name: "dbtable", tag: "const", value: guid, filters: [] },
    ],
  });

  it("recovers the statement with `table: null` instead of aborting to raw()", () => {
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, new RefIndex(), stored("") as never, {} as never));
    expect(source).not.toContain("raw(");
    expect(source).toContain("table: null");
  });

  it("still resolves a bound auth table", () => {
    const ctx = new DecodeContext();
    const source = printExpr(
      decodeStatement(ctx, new RefIndex(), stored(deriveGuid("dbo", "user")) as never, {} as never),
    );
    expect(source).not.toContain("table: null");
  });
});

/**
 * A conditional with NO condition — dropped into a stack and never filled in.
 *
 * 17 of the 20 conditional declines in a 187-workspace sweep were this: 9 store
 * `{expression: []}` and 8 store the empty associative-map form `[]`. Both are
 * authorable, and that is the whole point — `Condition` is
 * `SearchNode | SearchNode[]`, and `encodeComparison([])` produces exactly
 * `{expression: []}`, so an empty `when` reproduces the stored bytes. Nothing is
 * invented, and nothing the engine evaluates changes.
 */
describe("a conditional with an empty condition", () => {
  // The envelope a real stored conditional carries — all 17 empty ones in the
  // corpus store `elif: {run: []}`, which is what the factory writes back.
  const conditional = (expr: unknown) => ({
    name: "mvp:conditional",
    context: { expr, if: { run: [] }, elif: { run: [] }, else: { run: [] } },
  });

  for (const [label, expr] of [
    ["the {expression: []} spelling", { expression: [] }],
    ["the empty associative-map spelling", []],
  ] as const) {
    it(`recovers ${label} as an empty when, not raw()`, () => {
      const ctx = new DecodeContext();
      const source = printExpr(
        decodeStatement(ctx, new RefIndex(), conditional(expr) as never, {} as never),
      );
      expect(source).not.toContain("raw(");
      expect(source).toContain("when: []");
    });
  }

  it("still declines a condition it cannot spell, rather than emptying it", () => {
    // The load-bearing negative: a MIXED `a AND b OR c` container has no
    // authored form, and must stay raw() — emptying it would silently drop a
    // real condition and change which rows the branch takes.
    const node = (or: boolean) => ({
      or,
      type: "statement",
      group: { expression: [] },
      statement: { op: "=", left: { tag: "var", operand: "a", filters: [] }, right: { tag: "const", operand: "1", filters: [] } },
    });
    const ctx = new DecodeContext();
    const source = printExpr(
      decodeStatement(
        ctx,
        new RefIndex(),
        conditional({ expression: [node(false), node(false), node(true)] }) as never,
        {} as never,
      ),
    );
    expect(source).toContain("raw(");
  });
});
