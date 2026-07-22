/**
 * `f.geo.point` field type — a GeoJSON point column.
 */
import { table, f } from "@sidestep/core";

export const fieldGeoPoint = table({
  name: "ex_field_geo_point",
  schema: {
    location: f.geo.point(),
  },
});
