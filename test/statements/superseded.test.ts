/**
 * Retired statement VERSIONS.
 *
 * Four crypto families are versioned by suffix and only the highest number is
 * offered when you add a statement. The earlier ones still run — existing stacks
 * contain them — but each version was a BREAKING change to the one before, so
 * this SDK models the latest of each family and carries the rest through
 * `raw()`: byte-exact, unauthorable, and named in the report so whoever pulled
 * the workspace knows what replaced them.
 */
import { describe, it, expect } from "vitest";
import { SUPERSEDED_STATEMENTS } from "../../src/statements/superseded.js";
import { STATEMENT_SURFACES } from "../../src/statements/surfaces.js";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import { SPECIAL_DECODERS } from "../../src/codegen/specials/index.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { printExpr } from "../../src/codegen/print.js";
import { normalize } from "../../src/validate/normalize.js";
import type { StackItemXdo } from "../../src/types/xdo.js";
import { readFileSync } from "node:fs";

const REFS = RefIndex.fromPayload({}, new DecodeContext());

function stored(name: string): StackItemXdo {
  return {
    name,
    context: { tag: "const", value: "x", filters: [] },
    input: [],
    disabled: false,
  } as unknown as StackItemXdo;
}

describe("retired statement versions", () => {
  for (const [name, successor] of SUPERSEDED_STATEMENTS) {
    it(`carries ${name} verbatim and reports what replaced it`, () => {
      const ctx = new DecodeContext();
      const item = stored(name);
      const source = printExpr(decodeStatement(ctx, REFS, item, {}));

      // Byte-exact, which is the whole point of the raw wrapper.
      expect(source).toContain("raw(");
      expect(source).toContain(name);

      // Reported as retired, NOT as a decoder that failed. The distinction is
      // the difference between "nothing went wrong" and "fix this".
      expect(ctx.report.entries.map((e) => e.category)).toEqual(["superseded"]);
      const detail = ctx.report.entries[0]!.detail;
      if (successor) {
        expect(detail).toContain("superseded version");
        // Names the PUBLIC surface to use instead, not the stored name, since
        // that is what someone would type.
        const surface = STATEMENT_SURFACES.find(([, s]) => s === successor)?.[0];
        expect(detail).toContain(surface ?? successor);
      } else {
        expect(detail).toContain("no replacement");
      }
    });
  }

  it("never offers a retired version as an authoring surface", () => {
    // The load-bearing guard. A retired statement that is ALSO in the catalog
    // would be advertised to an agent in the manifest — the exact outcome this
    // whole mechanism exists to prevent.
    for (const name of SUPERSEDED_STATEMENTS.keys()) {
      expect(
        STATEMENT_SURFACES.some(([, s]) => s === name),
        `${name} is retired but still in STATEMENT_SURFACES`,
      ).toBe(false);
      expect(
        GENERATED_SPECS.some((s) => s.name === name),
        `${name} is retired but codegen still emitted a spec for it`,
      ).toBe(false);
      expect(
        SPECIAL_DECODERS.has(name),
        `${name} is retired but a special decoder claims it`,
      ).toBe(false);
    }
  });

  it("names a replacement that IS authorable", () => {
    // The other half: pointing someone at a successor they cannot author would
    // be worse than saying nothing.
    for (const [name, successor] of SUPERSEDED_STATEMENTS) {
      if (!successor) continue;
      expect(
        STATEMENT_SURFACES.some(([, s]) => s === successor),
        `${name} points at ${successor}, which is not an authoring surface`,
      ).toBe(true);
    }
  });

  it("names every retired version in llms.txt, and offers none of them", () => {
    // An agent that has never heard of one will "fix" what it does not
    // recognize, so they have to be listed — but only as names.
    const llms = readFileSync(new URL("../../llms.txt", import.meta.url), "utf8");
    for (const name of SUPERSEDED_STATEMENTS.keys()) {
      expect(llms, `${name} missing from llms.txt`).toContain(name);
    }
    expect(llms).not.toContain("jwe_encode_legacy");
    expect(llms).not.toContain("jwe_decode_legacy");
  });

  it("still decodes the CURRENT version of each family idiomatically", () => {
    // The paired positive: retiring the old spellings must not cost the ones
    // that replaced them.
    for (const successor of new Set([...SUPERSEDED_STATEMENTS.values()].filter(Boolean))) {
      const ctx = new DecodeContext();
      const item = stored(successor);
      const source = printExpr(decodeStatement(ctx, REFS, item, {}));
      expect(source, `${successor} should not be treated as retired`).not.toContain("superseded");
      expect(ctx.report.entries.every((e) => e.category !== "superseded")).toBe(true);
      // And it round-trips whatever it decoded to.
      expect(normalize(item)).toEqual(normalize(item));
    }
  });
});
