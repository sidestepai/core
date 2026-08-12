/**
 * `normalize()` and statement-output filters.
 *
 * A statement's `as` binding can carry a filter chain (`… as $x|to_upper`),
 * stored in the statement envelope's `output.filters`. `isEmptyOutput` used to
 * decide "this output shapes nothing" from `items` and `customize` alone, which
 * made a filter-bearing output collapse to nothing on BOTH sides of a round
 * trip: the decoder emitted source without the filters and the re-encode proof
 * still passed. These tests pin the emptiness contract so that cannot recur.
 */
import { describe, it, expect } from "vitest";
import { normalize, isEmptyOutput } from "../../src/validate/normalize.js";
import { filter } from "../../src/values/value.js";

const UPPER = filter("to_upper");

describe("isEmptyOutput", () => {
  it("collapses every spelling of `shapes nothing`", () => {
    // The four spellings the engine writes across generations, per the
    // predicate's own documentation.
    expect(isEmptyOutput(null)).toBe(true);
    expect(isEmptyOutput({})).toBe(true);
    expect(isEmptyOutput({ filters: [] })).toBe(true);
    expect(isEmptyOutput({ items: [], filters: [], customize: false })).toBe(true);
  });

  it("keeps an output that carries a selection or customization", () => {
    expect(isEmptyOutput({ items: ["id"], filters: [], customize: false })).toBe(false);
    expect(isEmptyOutput({ items: [], filters: [], customize: true })).toBe(false);
  });

  it("keeps an output whose only content is an `as` filter chain", () => {
    expect(isEmptyOutput({ items: [], filters: [UPPER], customize: false })).toBe(false);
    // The lean parser spelling carries filters too.
    expect(isEmptyOutput({ filters: [UPPER] })).toBe(false);
  });

  it("keeps a selection and a filter chain together", () => {
    expect(isEmptyOutput({ items: ["id"], filters: [UPPER], customize: false })).toBe(false);
  });
});

/**
 * `normalize` strips a filter's default `disabled:false` (it is elided on both
 * sides), so a normalized output is compared against the stripped shape rather
 * than the stored one. What matters here is that the key SURVIVES.
 */
const STRIPPED_UPPER = { name: "to_upper", arg: [] };

describe("normalize() on a filter-bearing statement output", () => {
  it("retains the output key instead of eliding it", () => {
    const stored = { output: { items: [], filters: [UPPER], customize: false } };
    expect(normalize(stored)).toEqual({
      output: { items: [], filters: [STRIPPED_UPPER], customize: false },
    });
  });

  it("still elides an output that shapes nothing", () => {
    expect(normalize({ output: { items: [], filters: [], customize: false } })).toEqual({});
    expect(normalize({ output: null })).toEqual({});
  });

  it("distinguishes a filtered binding from an unfiltered one", () => {
    // The assertion that would have caught the original defect: before the fix
    // both sides normalized to `{}` and compared equal, so a decoder that
    // dropped the filters passed its own re-encode proof.
    const withFilter = { as: "x2", output: { items: [], filters: [UPPER], customize: false } };
    const without = { as: "x2", output: { items: [], filters: [], customize: false } };
    expect(normalize(withFilter)).not.toEqual(normalize(without));
  });

  it("retains a filter chain alongside a column selection", () => {
    const stored = { output: { items: ["id"], filters: [UPPER], customize: false } };
    expect(normalize(stored)).toEqual({
      output: { items: ["id"], filters: [STRIPPED_UPPER], customize: false },
    });
  });
});
