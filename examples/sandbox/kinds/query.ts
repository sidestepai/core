/**
 * `query({...})` — an HTTP API endpoint (payload key `query`), published under
 * an API group. This is the object kind; its `stack` uses the statement surface.
 */
import { query, s, inp, ref, input } from "@sidestep/core";
import { api, users } from "../_shared.js";

export const getUserQuery = query({
  name: "ex_get_user",
  verb: "GET",
  apiGroup: api,
  // `history` omitted → inherits the API group's default (which inherits the
  // workspace). Set a scalar (`100`, `false`, `"all"`) to override per-endpoint.
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});

/**
 * URL PATH PARAMS — a `{param}` segment in `name` binds that URL segment to the
 * input of the same name, and segments chain. Every `{param}` MUST have a
 * matching input or `query()` throws: Xano treats an unbound marker as inert
 * route text, so the endpoint would answer on the path and see nothing.
 *
 * The name itself holds only letters, digits, `_`, `-`, `/` and the `{}` of a
 * param (max 200). A `.` is the one to watch: Xano does not reject it, it saves
 * the endpoint with an EMPTY name, which deploys clean and then 404s on every
 * request — so `query()` throws instead. A download endpoint is `ex_export_zip`
 * or `ex_export/zip`, with the file extension set in the response headers.
 *
 * Read the value with `inp("<param>")`, exactly like any other input. Inputs
 * that are NOT in the path (`verbose` here) stay ordinary query-string params.
 *
 * Client side, `getPath({ params })` builds the real URL — never interpolate by
 * hand, or a value containing `/` silently addresses a different endpoint:
 *
 *   userPostQuery.getPath({ params: { user_id: 7, slug: "hello" } })
 *     → "/api:<canonical>/ex_users/7/posts/hello"
 *   userPostQuery.toSearchParams({ verbose: true })  → "verbose=true"
 *     (the handle's own toSearchParams drops path params; the free
 *      `query.toSearchParams` has no view of the route and keeps every key)
 */
export const userPostQuery = query({
  name: "ex_users/{user_id}/posts/{slug}",
  verb: "GET",
  apiGroup: api,
  input: {
    user_id: input.int(),
    slug: input.text(),
    verbose: input.bool(),
  },
  stack: [s.db.get({ table: users, fieldValue: inp("user_id"), as: "user" })],
  response: ref("user"),
});

/**
 * DATABASE LINK — `input.dbLink(table)` is ONE entry that EXPANDS into one input
 * per COLUMN of the linked table. It is the most confusing input in the catalog
 * for exactly that reason: the entry is not the input.
 *
 * The `users` table's columns arrive here as individual request inputs, so they
 * are read by their own column names — `inp("name")`, `inp("email")` — NOT by
 * the entry's name. The expansion is live: add a column to `users` and it
 * becomes an input here with no change to this file.
 *
 * `hidden` drops columns from the expansion, which is what you almost always
 * want for server-managed columns (`id`, `created_at`) — a caller has no
 * business supplying them.
 *
 * `customize` tunes the columns that DO expand, one at a time: make one
 * required, give one a default, or bind a normalizing filter. Anything not named
 * expands exactly as the table declares it.
 *
 * By convention the editor names the entry after the table with a trailing `__`.
 * The name is just the map key and any name works; matching the convention keeps
 * a pulled workspace diffing cleanly against a hand-written one.
 */
export const signupQuery = query({
  name: "ex_signup",
  verb: "POST",
  apiGroup: api,
  input: {
    users__: input.dbLink(users, {
      hidden: ["id", "created_at"],
      customize: { email: { required: true, methods: ["lower"] } },
    }),
  },
  stack: [
    s.db.add({ table: users, row: { name: inp("name"), email: inp("email") }, as: "created" }),
  ],
  response: ref("created"),
});
