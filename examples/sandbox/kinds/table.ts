/**
 * `table({...})` — a database table (payload key `dbo`). Named-map `schema`,
 * `index` list, and `views`. System columns (`id`, `created_at`) auto-inject.
 *
 * `seed` ships starter rows into the table on deploy (deploy is a full replace,
 * so re-deploying re-seeds cleanly). Values are validated against the column
 * types before deploy. Omit `id` on an int-PK table and rows are auto-numbered
 * `1..N`; set `id` on every row or none.
 *
 * **A seeded table must be scalar-only.** The engine's content import cannot
 * write `f.json()`, `f.object({…})`, `f.vector(N)` or `{ array: true }`, and it
 * fails after the full replace has already cleared the workspace — so `export()`
 * refuses the combination up front. The column need not appear in any seed row;
 * declaring it is enough. Those column types are fine on an UNSEEDED table (see
 * `posts.tags` in `_shared.ts`); populate them from an endpoint instead.
 */
import { table, f, seedFile } from "@sidestep/core";

export const productTable = table({
  name: "ex_kind_products",
  schema: {
    sku: f.text({ required: true }),
    name: f.text({ required: true }),
    price: f.decimal({ default: "0" }),
    in_stock: f.bool({ default: "true" }),
    // An array column is fine here because this table is NOT seeded — see the
    // scalar-only `ex_kind_product_notes` below for the inline-seed shape.
    tags: f.text({ array: true }),
  },
  index: [
    { type: "unique", fields: [{ name: "sku" }] },
    { type: "btree", fields: [{ name: "price", op: "desc" }] },
  ],
});

/**
 * Inline `seed` — starter rows written straight into the def.
 *
 * Scalar columns only, which is the rule for any seeded table (see above).
 * `id` is omitted, so the rows are auto-numbered `1..N`.
 */
export const productNoteTable = table({
  name: "ex_kind_product_notes",
  schema: {
    sku: f.text({ required: true }),
    note: f.text(),
  },
  seed: [
    { sku: "SKU-001", note: "Aeron Chair — ships flat-packed" },
    { sku: "SKU-002", note: "Standing Desk — 3 week lead time" },
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
