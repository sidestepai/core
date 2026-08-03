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
import { fl, FILTER_NAMES, FILTER_SPECS } from "../../src/values/generated/filters.generated.js";
import { c, ref } from "../../src/values/value.js";

const ROOT = join(import.meta.dirname, "../..");

describe("fl.* filter catalog", () => {
  it("a typed filter builds a FilterXdo with named arg + variadic tail", () => {
    // `add` (math) is richly specified: one named arg `value`.
    const fx = fl.add(c.int(2));
    expect(fx).toEqual({ name: "add", disabled: false, arg: [c.int(2)] });
  });

  it("typed filters still accept extra args via the variadic tail", () => {
    const fx = fl.add(c.int(1), c.int(2));
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
    const fx = fl.upper();
    expect(fx).toEqual({ name: "upper", disabled: false, arg: [] });
    const cc = fl.concat(c.text("x"), c.text("y"));
    expect(cc.name).toBe("concat");
    expect(cc.arg).toHaveLength(2);
  });

  it("FILTER_NAMES is the authoritative membership and matches the fl keys", () => {
    // The catalog is the empirically runtime-resolvable set (issue #106): only
    // names a deployed value pipeline actually resolves. ~225 after dropping the
    // LSP's non-pipe pollution (operators, aggregates, type-methods, db.query).
    expect(FILTER_NAMES.length).toBeGreaterThan(200);
    for (const n of ["upper", "lower", "concat", "count", "first", "add"]) {
      expect(FILTER_NAMES).toContain(n);
    }
    // Confirmed phantoms — names that type-checked/exported but 500 at runtime —
    // must be gone from the surface (and from manifest.json/llms.txt with it).
    for (const n of ["coalesce", "is_empty", "to_upper", "to_lower", "covers", "between", "to_list"]) {
      expect(FILTER_NAMES).not.toContain(n);
      expect(fl).not.toHaveProperty(n);
    }
    expect(Object.keys(fl).sort()).toEqual([...FILTER_NAMES].sort());
  });

  it("every catalog name is in the empirical runtime-resolvable allowlist (issue #106)", () => {
    const { resolvable } = JSON.parse(
      readFileSync(join(ROOT, "vendor/filters-resolvable.json"), "utf8"),
    ) as { resolvable: string[] };
    const allow = new Set(resolvable);
    for (const n of FILTER_NAMES) expect(allow.has(n)).toBe(true);
  });

  it("direction-sensitive text filters document what the piped value means (#22)", () => {
    // Subject-piped: the piped value is the text, the arg is the needle.
    for (const n of ["starts_with", "istarts_with", "ends_with", "iends_with", "contains", "icontains"]) {
      expect(FILTER_SPECS[n]?.description).toMatch(/piped value is the subject text/);
    }
    // Pattern-piped: the piped value is the regex, the `subject` arg is the text —
    // the inverted convention that silently flips a guard if mixed up.
    for (const n of ["regex_test", "regex_match", "regex_replace"]) {
      expect(FILTER_SPECS[n]?.description).toMatch(/piped value is the regex PATTERN/);
    }
    // A direction-neutral filter carries no such note.
    expect(FILTER_SPECS["upper"]?.description ?? "").not.toMatch(/Direction:/);
  });

  it("path-taking filters accept a bare string path, coercing it to c.text (#76)", () => {
    // The natural spelling `fl.set("count", …)` now type-checks and is
    // byte-identical to the wrapped `fl.set(c.text("count"), …)` form.
    expect(fl.set("count", ref("count"))).toEqual(fl.set(c.text("count"), ref("count")));
    expect(fl.set("count", ref("count"))).toEqual({
      name: "set",
      disabled: false,
      arg: [c.text("count"), ref("count")],
    });
    // The whole path-taking family (all 20 object-manipulation filters whose arg
    // is named `path`) coerces identically — not just the `set` siblings.
    expect(fl.set_conditional("k", ref("v"), ref("cond")).arg[0]).toEqual(c.text("k"));
    expect(fl.set_ifnotempty("k", ref("v")).arg[0]).toEqual(c.text("k"));
    expect(fl.set_ifnotnull("k", ref("v")).arg[0]).toEqual(c.text("k"));
    expect(fl.get("count").arg[0]).toEqual(c.text("count"));
    expect(fl.has("count").arg[0]).toEqual(c.text("count"));
    expect(fl.unset("count").arg[0]).toEqual(c.text("count"));
    expect(fl.index_by("id").arg[0]).toEqual(c.text("id"));
  });

  it("coerces the path arg by name even when it is not first (append) (#76)", () => {
    // `append(value, path, …)` — the coerced arg is the second, positionally.
    expect(fl.append(ref("item"), "items")).toEqual({
      name: "append",
      disabled: false,
      arg: [ref("item"), c.text("items")],
    });
  });

  it("coerces path across the varied positional shapes of the family (#76)", () => {
    // `fsort(path, dir?, flag?)` — path first, two optional args trail it.
    expect(fl.fsort("scores.value").arg[0]).toEqual(c.text("scores.value"));
    // Single-arg `filter_*` family — path is the only arg.
    expect(fl.filter_empty("items")).toEqual({ name: "filter_empty", disabled: false, arg: [c.text("items")] });
    expect(fl.filter_null("items").arg[0]).toEqual(c.text("items"));
    // `array_remove(value, path, strict?)` — path second, a trailing arg after it.
    expect(fl.array_remove(ref("x"), "items").arg[1]).toEqual(c.text("items"));
  });

  it("a dynamic Value path still passes through unchanged (#76)", () => {
    const dyn = ref("dynamicKey");
    expect(fl.set(dyn, ref("v")).arg[0]).toBe(dyn);
    expect(fl.get(dyn).arg[0]).toBe(dyn);
  });

  it("only the path arg is coerced — other args still require a Value (#76)", () => {
    // @ts-expect-error — the value arg is not a coerced path; a bare string is rejected.
    fl.set("count", "not-a-value");
    // @ts-expect-error — get's `default` arg is a plain Value, not a coerced path.
    fl.get("count", "not-a-value");
  });

  /**
   * The nine filters a live engine RUNS with no argument at all, though the
   * upstream spec marks their `path` required (`vendor/filters-optional-args.json`,
   * produced by `scripts/probe-optional-path.ts`).
   *
   * This is not a style preference. A real pulled workspace stores `filter_null`
   * with `arg: []`, so codegen faithfully emits `fl.filter_null()` — and with a
   * required `path` that did not type-check, taking the whole generated tree
   * down with it.
   */
  const ENGINE_OPTIONAL_PATH = [
    "filter_empty", "filter_empty_array", "filter_empty_object", "filter_empty_text",
    "filter_false", "filter_null", "filter_zero", "fsort", "unique",
  ] as const;

  it.each(ENGINE_OPTIONAL_PATH)("fl.%s() takes no argument and emits an empty arg list", (name) => {
    const fx = (fl[name] as () => { name: string; arg: unknown[] })();
    expect(fx.name).toBe(name);
    // The stored shape a pulled workspace carries — not `[undefined]`, and not a
    // coerced empty string, either of which would change the bytes on deploy.
    expect(fx.arg).toEqual([]);
    expect(FILTER_SPECS[name]!.args![0]).toMatchObject({ name: "path", optional: true });
  });

  it("keeps `path` required on the eleven the engine rejects without it", () => {
    // The paired negative, and the reason this is a probed list rather than a
    // rule about the arg's name: the probe found `set`/`get`/`index_by`/
    // `array_remove` and seven others throw "Too few arguments to function".
    for (const name of ["set", "get", "unset", "has", "index_by", "array_remove", "append", "prepend"]) {
      expect(FILTER_SPECS[name]!.args![0], name).not.toMatchObject({ optional: true });
    }
    // @ts-expect-error — `get` still demands its path.
    fl.get();
    // @ts-expect-error — so does `set`.
    fl.set();
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
