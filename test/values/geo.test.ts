/**
 * GeoJSON → WKT at the write boundary (issue #208).
 *
 * Pinned to a live run against a fresh ephemeral:
 *
 *   write `{ type: "Point", coordinates: [1,2] }`  -> 400 Only strings are
 *                                                     supported for: POINT
 *   write `"POINT(1 2)"`                           -> 200, echoed as
 *                                                     { type: "point",
 *                                                       data: { lng: 1, lat: 2 } }
 *   read the same row (db.get / db.query, with and
 *   without `output`)                              -> at: null
 *
 * So the engine takes WKT and only WKT, coordinate order is (lng lat), and a
 * stored geo value is currently unreadable — the last of which is engine-side.
 */
import { describe, it, expect } from "vitest";
import { geo, geoToWkt } from "../../src/values/geo.js";
import { c } from "../../src/values/value.js";

describe("geoToWkt", () => {
  it("writes a point longitude-first, matching the live round trip", () => {
    // POINT(1 2) read back as { lng: 1, lat: 2 } — this exact string.
    expect(geoToWkt({ type: "Point", coordinates: [1, 2] })).toBe("POINT(1 2)");
  });

  it("emits each geometry's WKT grammar", () => {
    expect(geoToWkt({ type: "MultiPoint", coordinates: [[1, 2], [3, 4]] })).toBe(
      "MULTIPOINT(1 2, 3 4)",
    );
    expect(geoToWkt({ type: "LineString", coordinates: [[1, 2], [3, 4]] })).toBe(
      "LINESTRING(1 2, 3 4)",
    );
    expect(
      geoToWkt({
        type: "MultiLineString",
        coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]],
      }),
    ).toBe("MULTILINESTRING((1 2, 3 4), (5 6, 7 8))");
  });

  it("nests polygon rings, outer ring then holes", () => {
    // The case that catches ring-closure and separator bugs at once.
    expect(
      geoToWkt({
        type: "Polygon",
        coordinates: [
          [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
          [[1, 1], [2, 1], [2, 2], [1, 1]],
        ],
      }),
    ).toBe("POLYGON((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 1))");
  });

  it("double-nests a multipolygon", () => {
    expect(
      geoToWkt({
        type: "MultiPolygon",
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          [[[5, 5], [6, 5], [6, 6], [5, 5]]],
        ],
      }),
    ).toBe("MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))");
  });

  it("refuses an unclosed polygon ring, naming both ends", () => {
    // The engine reports this only as a parse failure after deploy.
    expect(() =>
      geoToWkt({ type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4]]] }),
    ).toThrow(/not closed.*starts at \(0 0\).*ends at \(0 4\)/s);
  });

  it("refuses a wrong-arity position and says which order is expected", () => {
    expect(() =>
      geoToWkt({ type: "Point", coordinates: [1, 2, 3] as unknown as [number, number] }),
    ).toThrow(/\[lng, lat\] pair.*longitude-FIRST/s);
  });

  it("refuses a non-finite coordinate", () => {
    expect(() => geoToWkt({ type: "Point", coordinates: [Number.NaN, 2] })).toThrow(
      /lng must be a finite number/,
    );
  });

  it("refuses a too-short line and a too-short ring", () => {
    expect(() => geoToWkt({ type: "LineString", coordinates: [[1, 2]] })).toThrow(/at least 2/);
    expect(() =>
      geoToWkt({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] }),
    ).toThrow(/at least 4/);
  });

  it("refuses an unknown geometry type, listing the accepted ones", () => {
    expect(() =>
      geoToWkt({ type: "Circle", coordinates: [1, 2] } as unknown as never),
    ).toThrow(/unknown geometry type "Circle".*Point/s);
  });
});

describe("geo()", () => {
  it("produces an ordinary text value — there is no geo tag on the wire", () => {
    expect(geo({ type: "Point", coordinates: [1, 2] })).toEqual(c.text("POINT(1 2)"));
  });

  it("leaves raw WKT alone as an escape hatch", () => {
    // A form the SDK does not model is still writable.
    expect(c.text("POINT(1 2)").value).toBe("POINT(1 2)");
  });
});
