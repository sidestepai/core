/**
 * Filter-aware result typing — `ApplyFilter`/`ApplyFilters` and the inference
 * that reads them.
 *
 * Every scalar/generic expectation here is anchored to an OBSERVED value, not to
 * the catalog's declaration: `examples/sandbox/_probe-filter-results.ts` ran one
 * filter per declared result category on a live engine, and the types below
 * report what that run actually returned. The declarations happened to be right
 * in all 15 cases — including `append`, whose description contradicts its own
 * declaration — but they were believed only after being run.
 *
 * These are type-level assertions; `expect(true)` keeps vitest happy while the
 * real check is `tsc` over this file.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { ApplyFilter, ApplyFilters } from "../../src/values/filter-result.js";
import type { FilterXdo } from "../../src/types/xdo.js";
import { c, ref, withFilters, filter, col } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import type { InferResponse } from "../../src/responses/infer.js";
import { s } from "../../src/statements/s.js";
import { defineFunction } from "../../src/function/define.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import type { InferRow } from "../../src/kinds/table.js";

/** Shorthand for a filter carrying its name at the type level. */
type F<N extends string> = FilterXdo<N>;

const users = table({ name: "fr_users", schema: { id: f.int(), email: f.text() } });

describe("ApplyFilter — scalar results (live-probed)", () => {
  it("maps text/string results to string", () => {
    expectTypeOf<ApplyFilter<string, "upper">>().toEqualTypeOf<string>();
    // `number_format` is the one filter declaring `string` rather than `text`;
    // the probe returned "1,234.50", the same JSON type.
    expectTypeOf<ApplyFilter<number, "number_format">>().toEqualTypeOf<string>();
    expect(true).toBe(true);
  });

  it("maps int/decimal/epochms results to number", () => {
    expectTypeOf<ApplyFilter<number[], "count">>().toEqualTypeOf<number>();
    expectTypeOf<ApplyFilter<number, "floor">>().toEqualTypeOf<number>();
    expectTypeOf<ApplyFilter<number, "round">>().toEqualTypeOf<number>();
    expectTypeOf<ApplyFilter<number[], "avg">>().toEqualTypeOf<number>();
    // epochms is a millisecond count (probe: 1767225600000), not a Date.
    expectTypeOf<ApplyFilter<string, "to_epochms">>().toEqualTypeOf<number>();
    expect(true).toBe(true);
  });

  it("maps bool results to boolean", () => {
    expectTypeOf<ApplyFilter<string, "empty">>().toEqualTypeOf<boolean>();
    expect(true).toBe(true);
  });

  it("maps concrete array results", () => {
    expectTypeOf<ApplyFilter<string, "split">>().toEqualTypeOf<string[]>();
    expectTypeOf<ApplyFilter<number, "range">>().toEqualTypeOf<number[]>();
    expect(true).toBe(true);
  });
});

describe("ApplyFilter — generic results", () => {
  it("`<T>` yields the element of the array it is given", () => {
    expectTypeOf<ApplyFilter<{ id: number }[], "first">>().toEqualTypeOf<{ id: number }>();
    expectTypeOf<ApplyFilter<number[], "last">>().toEqualTypeOf<number>();
    expect(true).toBe(true);
  });

  it("`<T>[]` keeps the array it is given", () => {
    expectTypeOf<ApplyFilter<number[], "reverse">>().toEqualTypeOf<number[]>();
    expectTypeOf<ApplyFilter<number[], "unique">>().toEqualTypeOf<number[]>();
    // `append`'s description says it returns the updated OBJECT; its declaration
    // says `<T>[]`. The probe returned [3,1,2,9] — the declaration is right.
    expectTypeOf<ApplyFilter<number[], "append">>().toEqualTypeOf<number[]>();
    expect(true).toBe(true);
  });

  it("`index_by` is a group-by — a record of ARRAYS, not the array it was given", () => {
    // Live-probed: `[{"id":7,…},{"id":9,…},{"id":7,…}] |index_by:"id"` returns
    // {"7":[{…},{…}],"9":[{…}]} — every value an array, one match included.
    // The catalog declares `<T>[]`, which would fold to the input array and let
    // `idx[key].name` type-check while being null at runtime.
    expectTypeOf<ApplyFilter<{ id: number; name: string }[], "index_by">>().toEqualTypeOf<
      Record<string, { id: number; name: string }[]>
    >();
    expectTypeOf<ApplyFilters<{ id: number }[], [F<"index_by">]>>().toEqualTypeOf<
      Record<string, { id: number }[]>
    >();
    expect(true).toBe(true);
  });

  it("a generic filter over a non-array bottoms out rather than guessing", () => {
    expectTypeOf<ApplyFilter<string, "first">>().toEqualTypeOf<unknown>();
    expectTypeOf<ApplyFilter<string, "reverse">>().toEqualTypeOf<unknown>();
    expect(true).toBe(true);
  });
});

describe("ApplyFilter — the honest floor", () => {
  it("an `any`-result filter is unknown, not a guess", () => {
    // `get`/`set`/`transform`/`json_decode` produce a shape no declaration could
    // name. These are the ones deliberately left unmodelled.
    expectTypeOf<ApplyFilter<{ id: number }, "get">>().toEqualTypeOf<unknown>();
    expectTypeOf<ApplyFilter<string, "json_decode">>().toEqualTypeOf<unknown>();
    expect(true).toBe(true);
  });

  it("a filter name that is not statically known is unknown", () => {
    // The `filter(someString)` escape hatch, and every decoded workspace chain.
    expectTypeOf<ApplyFilter<string, string>>().toEqualTypeOf<unknown>();
    expect(true).toBe(true);
  });
});

describe("ApplyFilter — null propagation", () => {
  it("carries null through rather than erasing it", () => {
    // Mirrors `IndexShape`'s treatment of a nullable base (#105): a `db.get` row
    // is `Row | null`, and filtering null yields null at runtime.
    expectTypeOf<ApplyFilter<{ id: number }[] | null, "first">>().toEqualTypeOf<
      { id: number } | null
    >();
    expectTypeOf<ApplyFilter<number[] | null, "count">>().toEqualTypeOf<number | null>();
    expect(true).toBe(true);
  });
});

describe("ApplyFilters — folding a chain", () => {
  it("applies left to right, each filter seeing the previous output", () => {
    // Live-confirmed: `[first, get("id")]` over `[{"id":1}]` returned 1, so the
    // second filter genuinely receives the first's result.
    expectTypeOf<ApplyFilters<string, [F<"trim">, F<"lower">]>>().toEqualTypeOf<string>();
    expectTypeOf<ApplyFilters<number[], [F<"reverse">, F<"first">]>>().toEqualTypeOf<number>();
    expect(true).toBe(true);
  });

  it("an empty chain leaves the shape untouched", () => {
    expectTypeOf<ApplyFilters<string, []>>().toEqualTypeOf<string>();
    expect(true).toBe(true);
  });

  it("a chain of unknown length says nothing", () => {
    expectTypeOf<ApplyFilters<string, FilterXdo[]>>().toEqualTypeOf<unknown>();
    expect(true).toBe(true);
  });

  it("does NOT catch a filter applied to a value it cannot accept", () => {
    // The documented limitation. `count` on text returns null at runtime (probed:
    // `"  Ab  "|trim|lower|count` → null), but its declared result is int, and
    // input compatibility is not modellable from the catalog — `range` is group
    // "array" yet takes an int, so the group is a domain label, not a contract.
    expectTypeOf<ApplyFilters<string, [F<"trim">, F<"lower">, F<"count">]>>().toEqualTypeOf<number>();
    expect(true).toBe(true);
  });
});

describe("withFilters carries its chain into response inference", () => {
  it("folds a filtered ref instead of degrading it to unknown", () => {
    const fn = defineFunction({
      name: "fr_count",
      stack: [s.db.query({ table: users, as: "rows" })],
      response: withFilters(ref("rows"), fl.count()),
    });
    expect(fn.name).toBe("fr_count");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<number>();
  });

  it("folds a multi-filter chain", () => {
    const fn = defineFunction({
      name: "fr_chain",
      stack: [s.db.query({ table: users, as: "rows" })],
      response: withFilters(ref("rows"), fl.reverse(), fl.first()),
    });
    expect(fn.name).toBe("fr_chain");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<InferRow<typeof users>>();
  });

  it("accepts the array call form with the same result", () => {
    const fn = defineFunction({
      name: "fr_arrayform",
      stack: [s.db.query({ table: users, as: "rows" })],
      response: withFilters(ref("rows"), [fl.reverse(), fl.first()]),
    });
    expect(fn.name).toBe("fr_arrayform");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<InferRow<typeof users>>();
  });

  it("still reports unknown where the chain cannot be folded", () => {
    const fn = defineFunction({
      name: "fr_unfoldable",
      stack: [s.db.query({ table: users, as: "rows" })],
      response: withFilters(ref("rows"), fl.get(c.text("0.email"))),
    });
    expect(fn.name).toBe("fr_unfoldable");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<unknown>();
  });

  it("folds each key of a record response independently", () => {
    const fn = defineFunction({
      name: "fr_record",
      stack: [s.db.query({ table: users, as: "rows" })],
      response: { total: withFilters(ref("rows"), fl.count()), rows: ref("rows") },
    });
    expect(fn.name).toBe("fr_record");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<{
      total: number;
      rows: InferRow<typeof users>[];
    }>();
  });
});

describe("asFilters retypes the statement's bound variable", () => {
  it("folds the chain over a db.get row", () => {
    const fn = defineFunction({
      name: "fr_as_get",
      stack: [
        s.db.get({ table: users, fieldValue: c.int(1), as: "u", asFilters: [fl.json_encode()] }),
      ],
      response: ref("u"),
    });
    expect(fn.name).toBe("fr_as_get");
    // `Row | null` → json_encode → `string | null`: the null survives the fold.
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<string | null>();
  });

  it("folds a chain over a db.query list", () => {
    const fn = defineFunction({
      name: "fr_as_count",
      stack: [s.db.query({ table: users, as: "rows", asFilters: [fl.count()] })],
      response: ref("rows"),
    });
    expect(fn.name).toBe("fr_as_count");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<number>();
  });

  it("folds a multi-filter chain down to the element type", () => {
    const fn = defineFunction({
      name: "fr_as_chain",
      stack: [s.db.query({ table: users, as: "rows", asFilters: [fl.reverse(), fl.first()] })],
      response: ref("rows"),
    });
    expect(fn.name).toBe("fr_as_chain");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<InferRow<typeof users>>();
  });

  it("leaves the shape untouched when no filters are attached", () => {
    const fn = defineFunction({
      name: "fr_as_none",
      stack: [s.db.query({ table: users, as: "rows" })],
      response: ref("rows"),
    });
    expect(fn.name).toBe("fr_as_none");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<InferRow<typeof users>[]>();
  });

  it("an empty chain is the same type as no chain", () => {
    const fn = defineFunction({
      name: "fr_as_empty",
      stack: [s.db.query({ table: users, as: "rows", asFilters: [] })],
      response: ref("rows"),
    });
    expect(fn.name).toBe("fr_as_empty");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<InferRow<typeof users>[]>();
  });

  it("reaches non-db branded statements too", () => {
    const fn = defineFunction({
      name: "fr_as_req",
      stack: [s.api.request({ url: c.text("https://x"), as: "resp", asFilters: [fl.json_encode()] })],
      response: ref("resp"),
    });
    expect(fn.name).toBe("fr_as_req");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<string>();
  });

  it("still bottoms out on an unfoldable filter", () => {
    const fn = defineFunction({
      name: "fr_as_unfoldable",
      stack: [
        s.db.get({ table: users, fieldValue: c.int(1), as: "u", asFilters: [fl.get(c.text("email"))] }),
      ],
      response: ref("u"),
    });
    expect(fn.name).toBe("fr_as_unfoldable");
    expectTypeOf<InferResponse<typeof fn>>().toEqualTypeOf<unknown>();
  });
});

describe("the phantom carriers stay off the wire", () => {
  it("a branded filter encodes to the same bytes as before", () => {
    expect(fl.upper()).toEqual({ name: "upper", disabled: false, arg: [] });
    expect(filter("upper")).toEqual({ name: "upper", disabled: false, arg: [] });
  });

  it("a filtered value carries no phantom keys at runtime", () => {
    const v = withFilters(c.text("x"), fl.upper());
    expect(Object.keys(v).sort()).toEqual(["filters", "tag", "value"]);
  });

  it("keeps the col() brand a filter chain is supposed to preserve", () => {
    // Regression guard for #32: the chain's new generic must not drop `__col`.
    const wrapped = withFilters(col("x"), fl.upper());
    expectTypeOf(wrapped).toExtend<{ readonly __col: true }>();
    expect(wrapped.tag).toBe("col");
  });
});
