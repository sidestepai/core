/**
 * `fl.regex_get_all_matches` filter.
 * Return all matches performed by a regular expression on the supplied subject text. Direction: the piped value is the regex PATTERN; the `subject` argument is the text tested against it — reversed vs starts_with/contains.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterRegexGetAllMatches = defineFunction({
  name: "ex_filter_regex_get_all_matches",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["regex_get_all_matches"]()))],
  response: ref("out"),
});
