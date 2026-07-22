/**
 * `fl.cosine_similarity` filter.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCosineSimilarity = defineFunction({
  name: "ex_filter_cosine_similarity",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["cosine_similarity"]()))],
  response: ref("out"),
});
