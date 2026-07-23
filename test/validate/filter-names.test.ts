/**
 * Offline filter-name validation (issue #106): the bundle walker that flags
 * `filter(name, …)` calls the engine can't resolve, before they 500 at runtime.
 */
import { describe, it, expect } from "vitest";
import { findUnresolvableFilters, suggestFilterNames } from "../../src/validate/filter-names.js";
import { workspace, defineFunction, query, apiGroup, s, c, ref, withFilters, filter, fl } from "../../src/index.js";
import { serializeBundle } from "../../src/emit/emit.js";

/** Compile a registry to the parsed bundle object the walker consumes. */
function bundleOf(ws: unknown): unknown {
  return JSON.parse(serializeBundle((ws as { export(): Parameters<typeof serializeBundle>[0] }).export()));
}

describe("offline filter-name validation (#106)", () => {
  it("flags an unresolvable raw filter() name and points at its owning object", () => {
    const fn = defineFunction({
      name: "coalesce_repro",
      stack: [s.set_var("x", withFilters(c.null(), filter("coalesce", c.int(1))))],
      response: ref("x"),
    });
    const findings = findUnresolvableFilters(bundleOf(workspace("w").registerFunctions([fn])));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.name).toBe("coalesce");
    // Location is the owning object, not the `mvp:set_var` kind marker.
    expect(findings[0]!.location).toBe("coalesce_repro");
  });

  it("passes a bundle that uses only resolvable filters", () => {
    const fn = defineFunction({
      name: "clean",
      stack: [s.set_var("x", withFilters(c.text("HI"), fl.lower(), fl.trim()))],
      response: ref("x"),
    });
    expect(findUnresolvableFilters(bundleOf(workspace("w").registerFunctions([fn])))).toEqual([]);
  });

  it("finds unresolvable names across carrier positions (set_var, response)", () => {
    const api = apiGroup({ name: "g", canonical: "g" });
    const q = query({
      name: "q",
      verb: "GET",
      apiGroup: api,
      stack: [s.set_var("a", withFilters(c.int(1), filter("num_max", c.int(2))))], // resolvable
      response: withFilters(c.text("x"), filter("to_upper")), // phantom, on the response value
    });
    const findings = findUnresolvableFilters(bundleOf(workspace("w").registerApiGroups([api]).registerQueries([q])));
    const names = findings.map((f) => f.name);
    expect(names).toContain("to_upper");
    expect(names).not.toContain("num_max");
  });

  it("suggests the likely intended name for common renames", () => {
    expect(suggestFilterNames("to_upper")).toContain("upper");
    expect(suggestFilterNames("to_lower")).toContain("lower");
    expect(suggestFilterNames("keys")).toContain("array_keys");
    // A total nonsense name yields no confident suggestion.
    expect(suggestFilterNames("zzqqxx_not_a_filter")).toEqual([]);
  });

  it("dedupes repeated name+location occurrences", () => {
    const fn = defineFunction({
      name: "dup",
      stack: [
        s.set_var("a", withFilters(c.int(1), filter("coalesce"))),
        s.set_var("b", withFilters(c.int(1), filter("coalesce"))),
      ],
      response: ref("a"),
    });
    const findings = findUnresolvableFilters(bundleOf(workspace("w").registerFunctions([fn])));
    expect(findings.filter((f) => f.name === "coalesce")).toHaveLength(1);
  });
});
