/**
 * `table({...})` — a database table (payload key `dbo`). Named-map `schema`,
 * `index` list, and `views`. System columns (`id`, `created_at`) auto-inject.
 *
 * `seed` ships starter rows into the table on deploy (deploy is a full replace,
 * so re-deploying re-seeds cleanly). Values are validated against the column
 * types before deploy. Omit `id` on an int-PK table and rows are auto-numbered
 * `1..N`; set `id` on every row or none.
 */
import { table, f, seedFile } from "@sidestep/core";

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

/**
 * `seedFile(path, import.meta.url)` — seed rows from a JSON file.
 *
 * Prefer this over `seed: () => import("./rows.json")` for file-backed data. The
 * thunk reads as though it keeps seed values server-side, but the `import()`
 * lives in YOUR module, so a bundler emits the JSON as a served chunk — a
 * frontend that imports any def whose module graph reaches this table then ships
 * the seed to the browser. A path string has nothing for a bundler to follow.
 *
 * `import.meta.url` is what makes the path resolve against THIS file rather than
 * the workspace entry or the working directory.
 *
 * Seed data is throwaway fixture data for disposable environments either way —
 * keep secrets out of it. `deploy --static` refuses to publish a frontend build
 * containing seed values from `access: "internal"` or `sensitive` columns.
 */
export const accessoryTable = table({
  name: "ex_kind_accessories",
  schema: {
    sku: f.text({ required: true }),
    name: f.text({ required: true }),
    price: f.decimal({ default: "0" }),
    in_stock: f.bool({ default: "true" }),
  },
  index: [{ type: "unique", fields: [{ name: "sku" }] }],
  seed: seedFile("./table.seed.json", import.meta.url),
});
