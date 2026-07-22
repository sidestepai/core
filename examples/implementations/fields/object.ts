/**
 * `f.object(children)` field type — a nested object column with typed children.
 */
import { table, f } from "@sidestep/core";

export const fieldObject = table({
  name: "ex_field_object",
  schema: {
    address: f.object({
      street: f.text(),
      city: f.text(),
      zip: f.text(),
    }),
  },
});
