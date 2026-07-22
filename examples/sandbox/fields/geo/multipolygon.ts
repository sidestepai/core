/**
 * `f.geo.multipolygon` field type — a GeoJSON multipolygon column.
 */
import { table, f } from "@sidestep/core";

export const fieldGeoMultipolygon = table({
  name: "ex_field_geo_multipolygon",
  schema: {
    location: f.geo.multipolygon(),
  },
});
