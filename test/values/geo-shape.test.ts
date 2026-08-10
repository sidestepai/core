/**
 * The value shape of an `f.geo.*` column (issue #208's surviving half).
 *
 * DEV-7605 fixed the null reads; what it did NOT fix is that the SDK declared
 * `{ type, coordinates }`, a shape the engine neither accepts nor returns.
 *
 * Pinned to a live round trip on a fresh ephemeral, after that fix:
 *
 *   seed  at:   { type: "point", data: { lng: 1, lat: 2 } }
 *         area: { type: "poly",  data: [{0,0},{4,0},{4,4},{0,4}] }
 *   read  at:   { type: "point", data: { lng: 1, lat: 2 } }
 *         area: { type: "poly",  data: [{0,0},{4,0},{4,4},{0,4},{0,0}] }
 *
 * So one shape is honest in both directions, and the engine closes a polygon
 * ring for you. Raw WKT text still works at runtime; it is simply not the typed
 * path, because a read never returns one.
 */
import { describe, it, expectTypeOf, expect } from "vitest";
import { table, tableColumns } from "../../src/kinds/table.js";
import type { InferRow } from "../../src/kinds/table.js";
import { coerceSeedRows } from "../../src/workspace/seed.js";
import { f } from "../../src/fields/catalog.js";
import type { XanoGeoValue, XanoGeoPosition } from "../../src/fields/value-types.js";

const places = table({
  name: "places",
  schema: { label: f.text(), at: f.geo.point(), area: f.geo.polygon() },
});

describe("the declared geo type matches what a read returns", () => {
  it("exposes `.data`, not `.coordinates`", () => {
    type Row = InferRow<typeof places>;
    expectTypeOf<Row["at"]>().toEqualTypeOf<XanoGeoValue>();
    expectTypeOf<Row["at"]>().toHaveProperty("data");
    // The old declaration promised this key; nothing ever returned it.
    expectTypeOf<Row["at"]>().not.toHaveProperty("coordinates");
  });

  it("types a point's data as one position", () => {
    const at: XanoGeoValue = { type: "point", data: { lng: 1, lat: 2 } };
    expectTypeOf(at.data).toMatchTypeOf<
      XanoGeoPosition | XanoGeoPosition[] | XanoGeoPosition[][]
    >();
  });

  it("accepts the polygon nesting the engine returns", () => {
    const area: XanoGeoValue = {
      type: "poly",
      data: [
        { lng: 0, lat: 0 },
        { lng: 4, lat: 0 },
      ],
    };
    expect(Array.isArray(area.data)).toBe(true);
  });
});

describe("a geo seed carries the same shape through untouched", () => {
  it("passes `{ type, data }` to the engine verbatim", () => {
    // The engine converts this to WKT itself — verified live — so the SDK must
    // NOT rewrite it. A previous release converted GeoJSON here; that was built
    // on the read bug and is gone.
    const rows = coerceSeedRows("places", tableColumns(places), [
      { at: { type: "point", data: { lng: 1, lat: 2 } } },
    ]);
    expect(rows[0]!.at).toEqual({ type: "point", data: { lng: 1, lat: 2 } });
  });

  it("passes raw WKT text through too", () => {
    const rows = coerceSeedRows("places", tableColumns(places), [{ at: "POINT(1 2)" }]);
    expect(rows[0]!.at).toBe("POINT(1 2)");
  });
});
