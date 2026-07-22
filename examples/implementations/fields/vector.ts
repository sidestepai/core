/**
 * `f.vector(size)` field type — a fixed-dimension embedding column.
 */
import { table, f } from "@sidestep/core";

export const fieldVector = table({
  name: "ex_field_vector",
  schema: {
    embedding: f.vector(1536),
  },
});
