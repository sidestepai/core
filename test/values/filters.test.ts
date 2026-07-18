/**
 * Filter catalog (`fl.*`) — the typed authoring surface over the value
 * `filters[]` pipeline, generated from the distilled `vendor/filters.json`.
 * Covers the typed/variadic factory shapes, membership, and an offline
 * freshness guard (committed generated file must match a fresh build from the
 * committed vendor snapshot — no upstream sources needed).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fl, FILTER_NAMES } from "../../src/values/generated/filters.generated.js";
import { c } from "../../src/values/value.js";

const ROOT = join(import.meta.dirname, "../..");

describe("fl.* filter catalog", () => {
  it("a typed filter builds a FilterXdo with named arg + variadic tail", () => {
    // `covers` (geo) is richly specified: one named arg `geometry`.
    const fx = fl.covers(c.text("POINT(0 0)"));
    expect(fx).toEqual({ name: "covers", disabled: false, arg: [c.text("POINT(0 0)")] });
  });

  it("typed filters still accept extra args via the variadic tail", () => {
    const fx = fl.covers(c.text("a"), c.text("b"));
    expect(fx.arg).toHaveLength(2);
  });

  it("optional named args (upstream default/optional) may be omitted", () => {
    // `trim`'s `mask` is flagged optional upstream → `fl.trim()` is valid and
    // serializes with no stray arg; passing it still works.
    expect(fl.trim()).toEqual({ name: "trim", disabled: false, arg: [] });
    expect(fl.trim(c.text("-")).arg).toEqual([c.text("-")]);
    // `number_format` has all-default args → all optional.
    expect(fl.number_format()).toEqual({ name: "number_format", disabled: false, arg: [] });
  });

  it("a name-only filter is reachable and variadic", () => {
    const fx = fl.to_upper();
    expect(fx).toEqual({ name: "to_upper", disabled: false, arg: [] });
    const cc = fl.concat(c.text("x"), c.text("y"));
    expect(cc.name).toBe("concat");
    expect(cc.arg).toHaveLength(2);
  });

  it("FILTER_NAMES is the authoritative membership and matches the fl keys", () => {
    expect(FILTER_NAMES.length).toBeGreaterThan(300);
    for (const n of ["to_upper", "concat", "count", "first", "covers", "add"]) {
      expect(FILTER_NAMES).toContain(n);
    }
    expect(Object.keys(fl).sort()).toEqual([...FILTER_NAMES].sort());
  });

  it("the committed generated file is fresh vs the vendor snapshot", () => {
    const committed = readFileSync(join(ROOT, "src/values/generated/filters.generated.ts"), "utf8");
    // Regenerate to a temp path from the SAME committed vendor JSON (offline).
    const out = execFileSync("npx", ["tsx", "scripts/codegen-filters.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(out).toMatch(/Wrote .*filters\.generated\.ts/);
    const regenerated = readFileSync(join(ROOT, "src/values/generated/filters.generated.ts"), "utf8");
    expect(regenerated).toBe(committed);
  });
});
