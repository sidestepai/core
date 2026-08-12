import { describe, it, expect } from "vitest";
import { c, ref, s, fl, lam, filter, withFilters, LAMBDA_CODE_FILTERS } from "../../src/index.js";
import { FILTER_SPECS } from "../../src/values/generated/filters.generated.js";

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
      s.api.lambda({ as: "out", code: c.text("return $this * 2") });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("$this");
    expect(message).toContain("s.lambda");
  });

  it("accepts a body using only the ambient bindings", () => {
    expect(() => s.api.lambda({ as: "out", code: c.text("return $var.subtotal * 1.2") })).not.toThrow();
  });

  it("accepts a lam.fn body authored for its surface", () => {
    const stmt = s.api.lambda({ as: "out", code: lam.fn(({ $var }) => $var.subtotal, { surface: "s.lambda" }) });
    expect(JSON.stringify(stmt)).toContain("return $var.subtotal;");
  });

  it("refuses a lam.fn body authored for a different surface", () => {
    const iterating = lam.fn(({ $this }) => $this * 2, { surface: "map" });
    expect(() => s.api.lambda({ as: "out", code: iterating })).toThrow(/\$this/);
  });

  it("still carries an EMPTY body, which is what the editor saves for a new statement", () => {
    // Authoring one is refused (`lam.raw("")` throws); carrying one that already
    // exists is not, or a pulled workspace stops round-tripping.
    expect(() => s.api.lambda({ as: "out", code: c.text("") })).not.toThrow();
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
    // `fl.transform` takes an expression on a different evaluation path — a
    // `$this` there is legal and means something else.
    expect(() => fl.transform(c.text("$this"))).not.toThrow();
    expect(() => fl.concat(c.text("$acc"))).not.toThrow();
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
