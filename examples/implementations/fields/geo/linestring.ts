/**
 * `f.geo.linestring` field type — a GeoJSON linestring column.
 */
import { table, f } from "@sidestep/core";

export const fieldGeoLinestring = table({
  name: "ex_field_geo_linestring",
  schema: {
    location: f.geo.linestring(),
  },
});
