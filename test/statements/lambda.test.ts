import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { c, ref, s, fl, lam, filter, withFilters, LAMBDA_CODE_FILTERS } from "../../src/index.js";
import { FILTER_SPECS } from "../../src/values/generated/filters.generated.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { printExpr } from "../../src/codegen/print.js";
import { STATEMENT_SURFACES } from "../../src/statements/surfaces.js";
import type { StackItemXdo } from "../../src/types/xdo.js";

/**
 * The guard at the call sites (issue #221).
 *
 * `lam.*` types the binding set, which is the primary enforcement — but only for
 * an author who uses it. These tests are about the OTHER door: a plain
 * `c.text(...)` body, passed to a filter or to the lambda statement, gets the
 * same answer at the same moment, because the check sits at the one choke point
 * every spelling passes through.
 */

describe("the lambda statement", () => {
  it("Covers #221: refuses a body referencing a binding it does not have", () => {
    let message = "";
    try {
      s.lambda({ as: "out", code: c.text("return $this * 2") });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("$this");
    expect(message).toContain("s.lambda");
  });

  it("accepts a body using only the ambient bindings", () => {
    expect(() => s.lambda({ as: "out", code: c.text("return $var.subtotal * 1.2") })).not.toThrow();
  });

  it("accepts a lam.fn body authored for its surface", () => {
    const stmt = s.lambda({ as: "out", code: lam.fn(({ $var }) => $var.subtotal, { surface: "s.lambda" }) });
    expect(JSON.stringify(stmt)).toContain("return $var.subtotal;");
  });

  it("refuses a lam.fn body authored for a different surface", () => {
    const iterating = lam.fn(({ $this }) => $this * 2, { surface: "map" });
    expect(() => s.lambda({ as: "out", code: iterating })).toThrow(/\$this/);
  });

  it("still carries an EMPTY body, which is what the editor saves for a new statement", () => {
    // Authoring one is refused (`lam.raw("")` throws); carrying one that already
    // exists is not, or a pulled workspace stops round-tripping.
    expect(() => s.lambda({ as: "out", code: c.text("") })).not.toThrow();
  });
});

describe("the lambda filters", () => {
  it("Covers #221: rejects a $acc body in fl.reduce at build time", () => {
    let message = "";
    try {
      withFilters(c.array([1, 2]), fl.reduce({ initial_value: 0, code: c.text("return $acc + $this") }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("$result");
    expect(message).toContain("issue #221");
  });

  it("builds the same chain with $result, and encodes as expected", () => {
    const chain = withFilters(c.array([1, 2]), fl.reduce({ initial_value: 0, code: c.text("return $result + $this") }));
    expect(chain.filters[0]).toEqual({
      name: "reduce",
      disabled: false,
      arg: [c.int(0), c.text("return $result + $this")],
    });
  });

  it("checks each filter against its OWN surface", () => {
    // `$result` is reduce's alone.
    expect(() => fl.map(c.text("return $result"))).toThrow(/\$result/);
    expect(() => fl.reduce(0, c.text("return $result"))).not.toThrow();
    // `$parent` is the iterating filters' alone.
    expect(() => fl.lambda(c.text("return $parent"))).toThrow(/\$parent/);
    expect(() => fl.map(c.text("return $parent.length"))).not.toThrow();
  });

  it("checks the low-level filter() spelling too", () => {
    expect(() => filter("reduce", c.int(0), c.text("return $acc"))).toThrow(/\$result/);
  });

  it("accepts a lam.fn body at its own surface and refuses it at another", () => {
    const doubled = lam.fn(({ $this }) => $this * 2, { surface: "map" });
    expect(() => fl.map(doubled)).not.toThrow();
    expect(() => fl.lambda(doubled)).not.toThrow(); // $this is bound at both
    const accumulating = lam.fn(({ $result, $this }) => $result + $this);
    expect(() => fl.map(accumulating)).toThrow(/\$result/);
  });

  it("passes a value it cannot read through unvalidated", () => {
    // A ref, an input, or a filtered value carries no body text. The guard must
    // not fire where it cannot see — it would be guessing.
    expect(() => fl.map(ref("someCode"))).not.toThrow();
    expect(() => fl.map(withFilters(c.text("return $acc"), fl.trim()))).not.toThrow();
  });

  it("leaves a filter that is not a lambda surface alone", () => {
    expect(() => fl.concat(c.text("$acc"))).not.toThrow();
  });

  it("does not apply the LAMBDA contract to fl.transform's expression", () => {
    // `fl.transform` runs on the expression path, so the lambda contract does
    // not describe it: `$result` is refused in a lambda body outside `reduce`,
    // while `$0` is exactly what an expression should say. The expression guard
    // owns this argument (issue #245) — it refuses `$this` on its own grounds,
    // with its own message, and this is the one that must NOT fire.
    expect(() => fl.transform(c.text("$0 * 2"))).not.toThrow();
    let message = "";
    try {
      fl.transform(c.text("$this"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("issue #245");
    expect(message).not.toContain("issue #221");
  });

  /**
   * The drift guard. A spec refresh that distills another `code`-taking filter
   * must classify its surface, or the new filter ships unguarded — which is how
   * #221 happened in the first place.
   */
  it("classifies every code-taking filter in the catalog", () => {
    const unclassified = Object.entries(FILTER_SPECS)
      .filter(([name, spec]) => spec.args?.some((a) => a.name === "code") && !(name in LAMBDA_CODE_FILTERS))
      .map(([name]) => name);
    expect(unclassified).toEqual([]);
  });

  it("points the guard at the slot the body actually occupies", () => {
    // reduce's body is the SECOND argument; every other lambda filter's is the
    // first. Keying on the wrong slot would silently stop checking.
    for (const [name, site] of Object.entries(LAMBDA_CODE_FILTERS)) {
      const args = FILTER_SPECS[name]?.args ?? [];
      expect(args[site.slot]?.name, name).toBe("code");
    }
  });
});

/**
 * The relocation (issue #221). A lambda runs wherever a stack runs — functions,
 * tasks, middleware, triggers — so filing it under `s.api.*` said something
 * false about where it is available. This is a rename of the authoring path
 * only: the stored statement is unchanged, which is what keeps a pulled
 * workspace round-tripping through the new key.
 */
describe("s.lambda", () => {
  it("is reachable at s.lambda", () => {
    expect(typeof s.lambda).toBe("function");
  });

  it("is gone from s.api — no alias, no shim", () => {
    // @ts-expect-error -- the statement moved to `s.lambda`
    expect(s.api.lambda).toBeUndefined();
    expect("lambda" in s.api).toBe(false);
  });

  it("keeps the stored name and bytes exactly as they were", () => {
    const stored = encodeStatement(s.lambda({ as: "x1", code: c.text("return 1"), timeout: c.int(10) }));
    expect(stored.name).toBe("mvp:lambda");
    expect(JSON.parse(JSON.stringify(stored)).input).toEqual([
      { name: "code", value: "return 1", tag: "const", filters: [], expand: false, ignore: false, children: [] },
      { name: "timeout", value: "10", tag: "const:int", filters: [], expand: false, ignore: false, children: [] },
    ]);
  });

  it("is what codegen emits for a stored lambda statement", () => {
    const stored = JSON.parse(
      JSON.stringify(encodeStatement(s.lambda({ as: "x1", code: c.text("return 1") }))),
    ) as StackItemXdo;
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, RefIndex.fromPayload({}, ctx), stored, {}));
    expect(source).toContain("s.lambda(");
    expect(source).not.toContain("s.api.lambda(");
  });

  it("appears in the surface catalog under its new key", () => {
    expect(STATEMENT_SURFACES).toContainEqual(["lambda", "mvp:lambda"]);
    expect(STATEMENT_SURFACES.some(([key]) => key === "api.lambda")).toBe(false);
  });
});

/**
 * The statement's `code` implies its surface too, and it is the surface with the
 * FEWEST bindings — which is exactly the one an author is most likely to get
 * wrong by pasting a filter body into it.
 */
describe("s.lambda implies its surface", () => {
  it("takes a body written straight into the statement", () => {
    const stmt = s.lambda({ as: "total", code: ({ $var }) => $var.subtotal * 1.2 });
    expect(JSON.stringify(stmt)).toContain("$var.subtotal");
  });

  it("encodes identically to the c.text form of the same body", () => {
    expect(s.lambda({ as: "x", code: ({ $var }) => $var.a })).toEqual(
      s.lambda({ as: "x", code: c.text("return $var.a;") }),
    );
  });

  it("Covers #221: refuses a filter binding written into the statement", () => {
    // @ts-expect-error -- $this is a filter binding; the statement surface has none
    expect(() => s.lambda({ as: "x", code: ({ $this }) => $this })).toThrow(/\$this/);
  });
});

/**
 * The emitted types and the runtime guard read two different tables — one in
 * `scripts/codegen-filters.ts` (which cannot import from `src` at emit time) and
 * one in `src/values/lambda.ts`. If they disagree, a filter's inline body is
 * typed for one surface and checked against another, which is worse than either
 * alone.
 */
describe("the codegen surface table and the runtime one agree", () => {
  it("types every lambda filter's code argument for the surface it is checked at", () => {
    const generated = readFileSync(
      join(import.meta.dirname, "../../src/values/generated/filters.generated.ts"),
      "utf8",
    );
    for (const [name, site] of Object.entries(LAMBDA_CODE_FILTERS)) {
      // The emitted signature names the surface in `LambdaBody<"…">`, on the
      // line that declares this filter.
      const line = generated.split("\n").find((l) => l.startsWith(`  ${JSON.stringify(name)}:`));
      expect(line, name).toBeDefined();
      expect(line, name).toContain(`LambdaBody<${JSON.stringify(site.surface)}>`);
    }
  });

  it("types no OTHER filter's argument as a lambda body", () => {
    const generated = readFileSync(
      join(import.meta.dirname, "../../src/values/generated/filters.generated.ts"),
      "utf8",
    );
    for (const line of generated.split("\n")) {
      const declared = /^ {2}"([^"]+)":/.exec(line)?.[1];
      if (declared === undefined || !line.includes("LambdaBody<")) continue;
      expect(Object.keys(LAMBDA_CODE_FILTERS), declared).toContain(declared);
    }
  });
});
