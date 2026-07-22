/**
 * `f.geo.multipoint` field type — a GeoJSON multipoint column.
 */
import { table, f } from "@sidestep/core";

export const fieldGeoMultipoint = table({
  name: "ex_field_geo_multipoint",
  schema: {
    location: f.geo.multipoint(),
  },
});
