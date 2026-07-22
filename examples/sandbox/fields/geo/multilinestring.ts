/**
 * `f.geo.multilinestring` field type — a GeoJSON multilinestring column.
 */
import { table, f } from "@sidestep/core";

export const fieldGeoMultilinestring = table({
  name: "ex_field_geo_multilinestring",
  schema: {
    location: f.geo.multilinestring(),
  },
});
