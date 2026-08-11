/**
 * `table({...})` — a database table (payload key `dbo`). Named-map `schema`,
 * `index` list, and `views`. System columns (`id`, `created_at`) auto-inject.
 *
 * `seed` ships starter rows into the table on deploy (deploy is a full replace,
 * so re-deploying re-seeds cleanly). Values are validated against the column
 * types before deploy. Omit `id` and rows are keyed for you — `1..N` on an int
 * PK, a stable derived uuid on a `idType: "uuid"` one; set `id` on every row or
 * none.
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
});

/**
 * Inline `seed` — starter rows written straight into the def, for a table whose
 * rows are small enough to read in place. `id` is omitted, so the rows are
 * auto-numbered `1..N`. Compare `accessoryTable` below, which reads the same
 * kind of data from a file.
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
 * `idType: "uuid"` — a uuid primary key instead of the default int.
 *
 * `id` is then a `string` everywhere it is inferred: a row type, a `db.get`
 * result, a `f.tableRef` pointing here (which must be `f.tableRef(t, { type:
 * "uuid" })` to match). Nothing else about the table changes.
 *
 * Seeding works the same — omit `id` and each row gets a stable uuid derived
 * from the table and row position, so re-exporting the same seed produces the
 * same keys. Supply `id` yourself (on every row) when the value has to be a
 * specific uuid, e.g. one a fixture or a frontend already hardcodes.
 */
export const auditTable = table({
  name: "ex_kind_audit_events",
  idType: "uuid",
  schema: {
    action: f.text({ required: true }),
    detail: f.text(),
  },
  seed: [{ action: "created", detail: "seeded example row" }, { action: "updated" }],
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
