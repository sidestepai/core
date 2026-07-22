/**
 * `fl.create_uid` filter.
 * Returns a unique 64bit unsigned int value seeded off the value
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCreateUid = defineFunction({
  name: "ex_filter_create_uid",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["create_uid"]()))],
  response: ref("out"),
});
