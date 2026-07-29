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
