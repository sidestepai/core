/**
 * Seed parity for the DEFERRED forms (issue #209).
 *
 * Two independent defects an author hits in sequence on one line:
 *
 * 1. A `.json` module's strings infer as `string`, never the literal union an
 *    `f.enum` column brands, so `seed: () => import("./rows.json")` matched no
 *    `table()` overload — a fourteen-level TS2769 whose real cause was on the
 *    last line. Deferred rows now widen literals; membership moves to export.
 * 2. `export` never called the thunk, so a defect only `deploy` could see
 *    failed AFTER an environment was provisioned.
 *
 * The type-level half is asserted with `expectTypeOf`, because a regression
 * there is a compile error in USER code, which no runtime test would catch.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { table } from "../../src/kinds/table.js";
import type { SeedSource } from "../../src/kinds/table.js";
import { coerceSeedRows } from "../../src/workspace/seed.js";
import { tableColumns } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";

/** What a `.json` module gives you: strings, never literal unions. */
const jsonRows: Array<{ name: string; count: number }> = [{ name: "a", count: 1 }];

const enumTable = table({
  name: "probe_g",
  schema: {
    name: f.enum(["a", "b"], { required: true }),
    count: f.int({ required: true }),
  },
});

describe("a deferred seed against an f.enum column", () => {
  it("typechecks with a thunk returning widened strings — the #209 repro", () => {
    // The exact shape that failed: only `f.enum` + a `.json` seed module.
    expect(() =>
      table({
        name: "probe_g",
        schema: {
          name: f.enum(["a", "b"], { required: true }),
          count: f.int({ required: true }),
        },
        seed: () => jsonRows,
      }),
    ).not.toThrow();
  });

  it("typechecks for an async thunk too", () => {
    expect(() =>
      table({
        name: "probe_async",
        schema: { name: f.enum(["a", "b"], { required: true }) },
        seed: async () => jsonRows.map((r) => ({ name: r.name })),
      }),
    ).not.toThrow();
  });

  it("accepts a widened string where the column brands a literal union", () => {
    // A thunk's rows are assignable with a plain `string`...
    expectTypeOf<() => Array<{ name: string; count: number }>>().toMatchTypeOf<
      SeedSource<{ name: "a" | "b"; count: number }>
    >();
    // ...while the INLINE arm still demands the literal.
    expectTypeOf<Array<{ name: string; count: number }>>().not.toMatchTypeOf<
      SeedSource<{ name: "a" | "b"; count: number }>
    >();
  });

  it("still rejects an invalid literal inline — widening must not weaken it", () => {
    // Reported at the `table(` call rather than at the offending key: the
    // overload is what fails to match, so the directive belongs here. That
    // diagnostic placement is the readability half of #209 and is unchanged —
    // what the widening fixes is that a DEFERRED source no longer fails at all.
    // @ts-expect-error "c" is not a declared member of the enum
    table({
      name: "probe_h",
      schema: { name: f.enum(["a", "b"], { required: true }), count: f.int() },
      seed: [{ name: "c", count: 1 }],
    });
  });
});

describe("enum membership is enforced at export instead", () => {
  const columns = tableColumns(enumTable);

  it("accepts a declared member", () => {
    expect(coerceSeedRows("probe_g", columns, [{ name: "a", count: 1 }])).toEqual([
      { name: "a", count: 1, id: 1 },
    ]);
  });

  it("names the column, the offending value, the row index and the allowed set", () => {
    let message = "";
    try {
      coerceSeedRows("probe_g", columns, [
        { name: "a", count: 1 },
        { name: "c", count: 2 },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('table "probe_g", seed row 1');
    expect(message).toContain('column "name"');
    expect(message).toContain('"c"');
    expect(message).toContain('"a", "b"');
  });

  it("checks each element of an enum array column", () => {
    const arrayTable = table({
      name: "probe_arr",
      schema: { tags: f.enum(["x", "y"], { array: true }) },
    });
    expect(() =>
      coerceSeedRows("probe_arr", tableColumns(arrayTable), [{ tags: ["x", "z"] }]),
    ).toThrow(/tags\[1\].*"z".*"x", "y"/s);
  });

  it("leaves an options-less enum to the engine", () => {
    // A column added in the editor and not yet given its values is a real,
    // engine-supported shape; it permits nothing, which is the engine's call.
    const bare = table({ name: "probe_bare", schema: { k: f.enum([]) } });
    expect(() => coerceSeedRows("probe_bare", tableColumns(bare), [{ k: "anything" }])).not.toThrow();
  });
});

describe("a geo seed value is converted to the WKT the engine accepts (#208)", () => {
  const places = table({ name: "p_places", schema: { at: f.geo.point() } });
  const columns = tableColumns(places);

  it("converts GeoJSON, because the engine refuses it verbatim", () => {
    // Verified live: a `{ type, coordinates }` write is a 400 and would have
    // been shipped as-is, landing as null — indistinguishable from a column the
    // author forgot to populate.
    expect(
      coerceSeedRows("p_places", columns, [{ at: { type: "Point", coordinates: [1, 2] } }]),
    ).toEqual([{ at: "POINT(1 2)", id: 1 }]);
  });

  it("passes raw WKT through untouched", () => {
    expect(coerceSeedRows("p_places", columns, [{ at: "POINT(3 4)" }])).toEqual([
      { at: "POINT(3 4)", id: 1 },
    ]);
  });

  it("names the table, row and column when the geometry cannot be encoded", () => {
    expect(() =>
      coerceSeedRows("p_places", columns, [{ at: { type: "Point", coordinates: [1] } }]),
    ).toThrow(/table "p_places", seed row 0, column "at" \(geo_point\).*\[lng, lat\] pair/s);
  });

  it("rejects a value that is neither WKT nor a geometry", () => {
    expect(() => coerceSeedRows("p_places", columns, [{ at: 42 }])).toThrow(
      /expected WKT text or a GeoJSON geometry/,
    );
  });
});
