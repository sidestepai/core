/**
 * Compile-checked "validate input at the boundary" recipe — mirrors the README
 * section of the same name and the #12 security case (a link shortener must
 * reject a `javascript:`/`data:` URL before it is stored and later navigated to).
 * Not a test file (no `.test` suffix) so vitest ignores it, but `tsc --noEmit`
 * type-checks it (test/ is in the tsconfig include), so the documented recipe
 * cannot rot.
 */
import { query, apiGroup, input, s, c, inp, expr, withFilters, fl } from "../../src/index.js";

export const linksGroup = apiGroup({ name: "links", canonical: "links" });

export const createLink = query({
  name: "create_link",
  verb: "POST",
  apiGroup: linksGroup,
  // `input.url()` names the intent; the http(s) constraint is enforced below.
  input: { url: input.url({ required: true }) },
  stack: [
    // Reject a non-http(s) URL at the boundary with a real 400 (badrequest),
    // NOT a 200 `s.throw` body a client could mistake for success (see #21).
    // `fl.regex_test` runs PHP `preg_match(pattern, subject)` and is PATTERN-piped:
    // the piped value is the regex, the arg is the text — the REVERSE of
    // `istarts_with` (#22). `c.regex(...)` delimiter-wraps the pattern (a bare
    // `c.text("^…")` is an invalid PCRE `withFilters` rejects, #128); case-insensitive
    // `^https?://` matches http/https and rejects `javascript:`/`data:`/`httpfoo://`.
    s.precondition({
      expr: expr(withFilters(c.regex("^https?://", "i"), fl.regex_test(inp("url"))), "=", c.bool(true)),
      error_type: "badrequest",
      error: c.text("url must be an http(s) URL"),
    }),
    // …persist the row, return it, etc.
  ],
});
