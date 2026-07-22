/**
 * `table({...})` — a database table (payload key `dbo`). Named-map `schema`,
 * `index` list, and `views`. System columns (`id`, `created_at`) auto-inject.
 */
import { table, f } from "@sidestep/core";

export const productTable = table({
  name: "ex_kind_products",
  schema: {
    sku: f.text({ required: true }),
    name: f.text({ required: true }),
    price: f.decimal({ default: "0" }),
    in_stock: f.bool({ default: "true" }),
    tags: f.text({ array: true }),
  },
  index: [
    { type: "unique", fields: [{ name: "sku" }] },
    { type: "btree", fields: [{ name: "price", op: "desc" }] },
  ],
});
