/**
 * Compile-checked "validate input at the boundary" recipe — mirrors the README
 * section of the same name and the #12 security case (a link shortener must
 * reject a `javascript:`/`data:` URL before it is stored and later navigated to).
 * Not a test file (no `.test` suffix) so vitest ignores it, but `tsc --noEmit`
 * type-checks it (test/ is in the tsconfig include), so the documented recipe
 * cannot rot.
 */
import { query, apiGroup, input, s, c, inp, expr, withFilters, fl } from "../../src/index.js";

const links = apiGroup({ name: "links", canonical: "links" });

export const createLink = query({
  name: "create_link",
  verb: "POST",
  apiGroup: links,
  // `input.url()` names the intent; the http(s) constraint is enforced below.
  input: { url: input.url({ required: true }) },
  stack: [
    // Reject a non-http(s) URL at the boundary with a real 400 (badrequest),
    // NOT a 200 `s.throw` body a client could mistake for success (see #21).
    // `fl.istarts_with` pipes the SUBJECT (the url); the arg is the prefix (#22).
    s.precondition({
      expr: expr(withFilters(inp("url"), fl.istarts_with(c.text("http"))), "=", c.bool(true)),
      error_type: "badrequest",
      error: c.text("url must start with http:// or https://"),
    }),
    // …persist the row, return it, etc.
  ],
});
