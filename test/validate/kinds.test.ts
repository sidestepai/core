import { describe, it, expect } from "vitest";
import {
  ROUND_TRIP_KINDS,
  fixtureDirForKind,
  indexByIdentity,
  resolveMatch,
} from "../../src/validate/kinds.js";

describe("kind registry", () => {
  it("includes dbo and function but excludes server/deploy blobs", () => {
    const keys = ROUND_TRIP_KINDS.map((k) => k.key);
    expect(keys).toContain("dbo");
    expect(keys).toContain("function");
    for (const blob of ["workspace", "branch", "market_item", "app", "vault"]) {
      expect(keys).not.toContain(blob);
    }
  });

  it("maps kinds to their real corpus dirs (function→statements, tool→toolset)", () => {
    expect(fixtureDirForKind("dbo")).toBe("tables");
    expect(fixtureDirForKind("function")).toBe("statements");
    expect(fixtureDirForKind("tool")).toBe("toolset");
    expect(fixtureDirForKind("nope")).toBeUndefined();
  });
});

describe("indexByIdentity", () => {
  it("indexes by both guid and name and flags duplicates", () => {
    const idx = indexByIdentity([
      { guid: "g1", name: "a" },
      { guid: "g2", name: "a" }, // duplicate name
      { guid: "g1", name: "c" }, // duplicate guid
    ]);
    expect(idx.byGuid.size).toBe(2);
    expect(idx.duplicateGuids.has("g1")).toBe(true);
    expect(idx.duplicateNames.has("a")).toBe(true);
  });

  it("skips objects with no usable identity", () => {
    const idx = indexByIdentity([{ guid: "", name: "" }, {}]);
    expect(idx.byGuid.size).toBe(0);
    expect(idx.byName.size).toBe(0);
  });
});

describe("resolveMatch", () => {
  const index = indexByIdentity([{ guid: "g1", name: "alpha", v: 1 }]);

  it("matches by guid first", () => {
    const r = resolveMatch({ guid: "g1", name: "renamed" }, index);
    expect(r).toEqual({ outcome: "found", fetched: { guid: "g1", name: "alpha", v: 1 } });
  });

  it("falls back to name when the compiled object has no guid", () => {
    const r = resolveMatch({ name: "alpha" }, index);
    expect(r.outcome).toBe("found");
  });

  it("reports missing when neither guid nor name resolves", () => {
    expect(resolveMatch({ name: "ghost" }, index).outcome).toBe("missing");
    expect(resolveMatch({}, index).outcome).toBe("missing");
  });

  it("reports ambiguous when the resolved key collides", () => {
    const dup = indexByIdentity([
      { name: "same", a: 1 },
      { name: "same", a: 2 },
    ]);
    expect(resolveMatch({ name: "same" }, dup).outcome).toBe("ambiguous");
  });
});
