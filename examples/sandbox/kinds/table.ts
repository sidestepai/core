/**
 * `table({...})` — a database table (payload key `dbo`). Named-map `schema`,
 * `index` list, and `views`. System columns (`id`, `created_at`) auto-inject.
 *
 * `seed` ships starter rows into the table on deploy (deploy is a full replace,
 * so re-deploying re-seeds cleanly). Values are validated against the column
 * types before deploy. Omit `id` on an int-PK table and rows are auto-numbered
 * `1..N`; set `id` on every row or none.
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
  seed: [
    { sku: "SKU-001", name: "Aeron Chair", price: 1395, in_stock: true, tags: ["furniture", "ergonomic"] },
    { sku: "SKU-002", name: "Standing Desk", price: 599, in_stock: false, tags: ["furniture"] },
  ],
});
