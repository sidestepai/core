/**
 * Compile-checked authoring recipes — mirrors the small doc snippets added for
 * #13 (README "Tables & fields" / "Statements, values & inputs" and the matching
 * llms.txt notes). Not a test file (no `.test` suffix) so vitest ignores it, but
 * `tsc --noEmit` type-checks it (test/ is in the tsconfig include), so the
 * documented shapes cannot silently drift from the real API.
 */
import {
  table,
  query,
  apiGroup,
  input,
  f,
  s,
  c,
  inp,
  col,
  ref,
  fl,
  withFilters,
  type InferRow,
} from "../../src/index.js";

// Array column → `string[]` in InferRow; tableRef takes standard FieldOptions;
// system columns and a declared unique index all coexist.
export const links = table({
  name: "links",
  schema: {
    url: f.text({ required: true }),
    tags: f.text({ array: true }), // list column
    owner: f.tableRef("users", { required: true }), // FieldOptions on tableRef
    clicks: f.int({ default: 0 }),
  },
  index: [{ type: "unique", fields: [{ name: "url" }] }], // `unique` shorthand
});

// `tags` is string[]; `id`/`created_at` are present from the system columns.
// (Asserted at the type level in the companion test via `InferRow`.)
export type LinkRow = InferRow<typeof links>;

const api = apiGroup({ name: "links", canonical: "links" });

// Read-modify-write: increment a counter from its current column value, and
// sort/paging shapes on db.query (system column `created_at` as a sort target).
export const bumpClicks = query({
  name: "bump_clicks",
  verb: "POST",
  apiGroup: api,
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.edit({
      table: links,
      fieldValue: inp("id"),
      // `row` is a partial keyed by column; increment from the current value.
      row: { clicks: withFilters(col("clicks"), fl.add(c.int(1))) },
      as: "updated",
    }),
    s.db.query({
      table: links,
      sort: [{ sortBy: "created_at", dir: "desc" }],
      paging: { page: c.int(1), per_page: c.int(25) },
      as: "recent",
    }),
    s.return(ref("updated")),
  ],
});
