/**
 * `f.geo.polygon` field type — a GeoJSON polygon column.
 */
import { table, f } from "@sidestep/core";

export const fieldGeoPolygon = table({
  name: "ex_field_geo_polygon",
  schema: {
    location: f.geo.polygon(),
  },
});
