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
  ref,
  fl,
  withFilters,
  type InferRow,
  type InferResponse,
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

export const api = apiGroup({ name: "links", canonical: "links" });

// Read-modify-write: increment a counter from its current column value, and
// sort/paging shapes on db.query (system column `created_at` as a sort target).
export const bumpClicks = query({
  name: "bump_clicks",
  verb: "POST",
  apiGroup: api,
  input: { id: input.int({ required: true }) },
  stack: [
    // Read the row first: `col()` does NOT resolve to the stored value inside a
    // `db.edit` `row` (it evaluates to null — issue #32), so increment off the
    // read-back value via `ref(...)`.
    s.db.get({ table: links, fieldValue: inp("id"), as: "current" }),
    s.db.edit({
      table: links,
      fieldValue: inp("id"),
      // `row` is a partial keyed by column; increment from the read value.
      row: { clicks: withFilters(ref("current.clicks"), fl.add(c.int(1))) },
      as: "updated",
    }),
    s.db.query({
      table: links,
      sort: [{ sortBy: "created_at", dir: "desc" }],
      paging: { page: 1, per_page: 25 },
      as: "recent",
    }),
  ],
  // A query's response comes from `response:`, not s.return.
  response: ref("updated"),
});

// `InferResponse<typeof query>` — the read-side round trip (#5). A list endpoint
// that returns the `db.query` result variable derives `InferRow<typeof links>[]`
// with no codegen and no hand-assertion.
export const listLinks = query({
  name: "list_links",
  verb: "GET",
  apiGroup: api,
  stack: [s.db.query({ table: links, as: "rows" })],
  response: ref("rows"),
});
export type ListLinksResponse = InferResponse<typeof listLinks>; // InferRow<typeof links>[]

// A `get` that selects specific columns narrows the derived row automatically —
// and, since `db.get` misses to `null`, the derived type carries `| null` (#105).
export const getLinkSlug = query({
  name: "get_link_slug",
  verb: "GET",
  apiGroup: api,
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: links, fieldValue: inp("id"), output: ["id", "url"], as: "row" })],
  response: ref("row"),
});
export type GetLinkSlugResponse = InferResponse<typeof getLinkSlug>; // Pick<…, "id" | "url"> | null

// A `get` binds `null` on a miss, so returning it directly derives `Row | null`
// with no override needed (#105) — the client must handle the not-found path.
export const getLinkOrNull = query({
  name: "get_link_or_null",
  verb: "GET",
  apiGroup: api,
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: links, fieldValue: inp("id"), as: "row" })],
  response: ref("row"),
});
export type GetLinkOrNullResponse = InferResponse<typeof getLinkOrNull>; // InferRow<typeof links> | null
