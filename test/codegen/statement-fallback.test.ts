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

function fallbackDetail(stored: Record<string, unknown>): string {
  const ctx = new DecodeContext();
  decodeStack(ctx, new RefIndex({ payload: {} } as never), [stored as never], {} as never);
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
