/**
 * Statements the engine WRITES but will not read back (#235).
 *
 * The sibling of `superseded.test.ts`, and the contrast is what each test is
 * checking. A retired VERSION keeps running exactly as stored, so a pulled
 * workspace holding one pushes straight back and the right instruction is
 * "leave it alone". One of these makes the workspace un-importable, so the
 * right instruction is the opposite — "replace it" — and `export()` enforces
 * that rather than leaving it to be discovered as a 500 mid-import.
 *
 * `mvp:placeholder` is the population: the engine substitutes one for a
 * statement it could not resolve so the export stays well-formed, and then has
 * no class to instantiate on the way back in. SideStep shipped an `s.placeholder`
 * factory for it, which could only ever produce a workspace that would not
 * deploy.
 */
import { describe, it, expect } from "vitest";
import { DECODE_ONLY_STATEMENTS } from "../../src/statements/decode-only.js";
import { SUPERSEDED_STATEMENTS } from "../../src/statements/superseded.js";
import { STATEMENT_SURFACES } from "../../src/statements/surfaces.js";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import { SPECIAL_DECODERS } from "../../src/codegen/specials/index.js";
import { isRegisteredStatement } from "../../src/statements/statement.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { printExpr } from "../../src/codegen/print.js";
import { severityOf } from "../../src/codegen/report.js";
import type { StackItemXdo } from "../../src/types/xdo.js";
import { readFileSync } from "node:fs";

const REFS = RefIndex.fromPayload({}, new DecodeContext());

function stored(name: string): StackItemXdo {
  return { name, context: { name: "todo" }, input: [], disabled: false } as unknown as StackItemXdo;
}

describe("statements the engine writes but will not import", () => {
  for (const [name, reason] of DECODE_ONLY_STATEMENTS) {
    it(`carries ${name} verbatim and says what to do about it`, () => {
      const ctx = new DecodeContext();
      const source = printExpr(decodeStatement(ctx, REFS, stored(name), {}));

      // Byte-exact. Dropping the statement would silently rewrite the pulled
      // workspace into something that imports but is missing a step.
      expect(source).toContain("raw(");
      expect(source).toContain(name);

      // Its own category — not `raw-fallback` (which reads as "our decoder is
      // incomplete") and not `superseded` (which reads as "nothing to do").
      expect(ctx.report.entries.map((e) => e.category)).toEqual(["decode-only"]);
      expect(severityOf("decode-only")).toBe("warning");
      expect(ctx.report.entries[0]!.detail).toContain(reason.slice(0, 40));
      expect(ctx.report.entries[0]!.detail).toContain("export()");
    });
  }

  it("offers none of them as an authoring surface, anywhere", () => {
    // The load-bearing guard, and the whole fix for #235: a statement in the
    // catalog is advertised to an agent through the manifest, and every
    // workspace an agent then writes with it fails to import.
    for (const name of DECODE_ONLY_STATEMENTS.keys()) {
      expect(
        STATEMENT_SURFACES.some(([, s]) => s === name),
        `${name} cannot import but is still in STATEMENT_SURFACES`,
      ).toBe(false);
      expect(
        isRegisteredStatement(name),
        `${name} cannot import but still has a registered factory`,
      ).toBe(false);
      expect(
        GENERATED_SPECS.some((s) => s.name === name),
        `${name} cannot import but codegen still emitted a spec for it`,
      ).toBe(false);
      expect(
        SPECIAL_DECODERS.has(name),
        `${name} cannot import but a special decoder claims it — it would decode to a ` +
          `factory call that does not exist`,
      ).toBe(false);
    }
  });

  it("keeps the two unauthorable registries disjoint", () => {
    // They dispatch in sequence and carry opposite instructions, so a name in
    // both would report whichever arm ran first — silently the wrong advice.
    for (const name of DECODE_ONLY_STATEMENTS.keys()) {
      expect(SUPERSEDED_STATEMENTS.has(name), `${name} is in both registries`).toBe(false);
    }
  });

  it("names every one of them in llms.txt, and offers none", () => {
    const llms = readFileSync(new URL("../../llms.txt", import.meta.url), "utf8");
    for (const name of DECODE_ONLY_STATEMENTS.keys()) {
      expect(llms, `${name} missing from llms.txt`).toContain(name);
    }
    // The retired-version block says "leave them"; this block must not be read
    // as part of it.
    expect(llms).toContain("will NOT import back");
    expect(llms).not.toContain("s.placeholder");
  });
});
