/**
 * `geo(geometry)` — a value for an `f.geo.*` column, written as GeoJSON.
 *
 * The engine accepts WKT text and refuses GeoJSON outright, so this converts
 * and hands back a text value. Coordinates are longitude-FIRST and a polygon
 * ring must repeat its first position as its last; both mistakes are refused
 * at build time rather than surfacing as an engine parse error.
 *
 * ⚠ Reading a geo column back currently returns `null` on every path — the
 * `{ type, data }` shape appears only in the echo a `db.add` returns.
 */
import { defineFunction, s, c, ref, geo, table, f } from "@sidestep/core";

export const geoPlaces = table({
  name: "ex_value_geo_places",
  schema: { label: f.text(), at: f.geo.point(), area: f.geo.polygon() },
});

export const geoValue = defineFunction({
  name: "ex_value_geo",
  stack: [
    s.db.add({
      table: geoPlaces,
      row: {
        label: c.text("HQ"),
        at: geo({ type: "Point", coordinates: [-122.4194, 37.7749] }),
        // A closed ring: first position repeated as the last.
        area: geo({
          type: "Polygon",
          coordinates: [[[-122.5, 37.7], [-122.3, 37.7], [-122.3, 37.9], [-122.5, 37.9], [-122.5, 37.7]]],
        }),
      },
      as: "row",
    }),
  ],
  response: ref("row"),
});
