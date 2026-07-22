/**
 * `fl.create_object` filter (group: transform).
 * Creates an object based on a list of keys and a list of values
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@sidestep/core";

export const filterCreateObject = defineFunction({
  name: "ex_filter_create_object",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["create_object"]()))],
  response: ref("out"),
});
