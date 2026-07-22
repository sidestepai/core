/**
 * `fl.regex_matches` filter.
 * Tests if a regular expression matches the supplied subject text. Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterRegexMatches = defineFunction({
  name: "ex_filter_regex_matches",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["regex_matches"]()))],
  response: ref("out"),
});
