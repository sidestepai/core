/**
 * `fl.strip_html` filter.
 * Removes HTML tags from a string
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterStripHtml = defineFunction({
  name: "ex_filter_strip_html",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["strip_html"]()))],
  response: ref("out"),
});
