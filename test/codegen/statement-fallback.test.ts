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
