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
import { fl, FILTER_NAMES, FILTER_SPECS, FILTER_REQUIRED_ARGS } from "../../src/values/generated/filters.generated.js";
import { c, ref, filter } from "../../src/values/value.js";

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

  /**
   * #229. The path-only coercion above used to be the WHOLE rule, and the
   * asymmetry is what made it a bug: `fl.get("count")` worked first try, so an
   * author learned "bare literals are fine", and then the argument sitting next
   * to it rejected one. Every argument takes a bare scalar now.
   */
  it("accepts a bare scalar in EVERY argument position, not just the path (#229)", () => {
    // The audit's exact example: identical bytes to the fully explicit form.
    expect(fl.get("a.b", 0)).toEqual(fl.get(c.text("a.b"), c.int(0)));
    // A non-path arg on a filter whose path is not first.
    expect(fl.array_remove(ref("x"), "items", true).arg[2]).toEqual(c.bool(true));
    // The variadic tail coerces too — otherwise the rule breaks at arg N+1.
    expect(fl.concat("a", 1, false).arg).toEqual([c.text("a"), c.int(1), c.bool(false)]);
  });

  it("wraps each scalar as the constant an author would have typed (#229)", () => {
    expect(fl.get("k", 7).arg[1]).toEqual(c.int(7));
    // Integral vs fractional is the c.int/c.decimal split, keyed on the runtime
    // value — a `decimal`-typed arg given `2` is still `const:int`, because that
    // is what writing it by hand would produce.
    expect(fl.get("k", 1.5).arg[1]).toEqual(c.decimal(1.5));
    expect(fl.get("k", true).arg[1]).toEqual(c.bool(true));
    expect(fl.get("k", "x").arg[1]).toEqual(c.text("x"));
  });

  it("still rejects a bare object or array — scalars only (#229)", () => {
    // `c.obj`/`c.array` carry a deliberate type-level diagnostic the audit
    // singled out as worth preserving (#230). Coercing these here would route
    // around it.
    // @ts-expect-error — an object literal is not a scalar.
    fl.get("count", { a: 1 });
    // @ts-expect-error — an array literal is not a scalar.
    fl.get("count", [1, 2]);
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

/**
 * #198. `fsort`'s comparator switch has five arms and its `default:` arm falls
 * through to `itext`, so an unrecognized `type` sorts case-insensitively as TEXT
 * and returns the wrong order with no error anywhere. That is how a "top N by
 * score/distance/recency" endpoint built the natural way comes out wrong.
 */
describe("fl.fsort comparator modes (#198)", () => {
  it("accepts each of the five modes the engine branches on", () => {
    for (const mode of ["text", "itext", "natural", "inatural", "number"] as const) {
      expect(fl.fsort("score", mode).arg[1]).toEqual(c.text(mode));
    }
  });

  it("refuses the spellings that lie, at compile time", () => {
    // Neither is in the engine's switch — both fall through to `itext` and sort
    // as text. The failure is silent, so the type is the only place it can be
    // caught.
    // @ts-expect-error — "decimal" is not a comparator mode; a numeric sort is "number".
    fl.fsort("score", "decimal");
    // @ts-expect-error — "int" is not a comparator mode; a numeric sort is "number".
    fl.fsort("score", "int");
  });

  it("still lets a Value through, so a pulled workspace round-trips", () => {
    // The deliberate escape hatch, and the reason this is a typing change rather
    // than a throw: codegen emits a stored `"decimal"` as `c.text("decimal")`,
    // and a workspace holding one has to stay exportable.
    expect(fl.fsort("score", c.text("decimal")).arg[1]).toEqual(c.text("decimal"));
  });

  it("names the accepted set in llms.txt rather than the word `enum`", () => {
    // Printing "enum" is what made this expensive — the members were
    // discoverable only by trying spellings against a live engine.
    const llms = readFileSync(new URL("../../llms.txt", import.meta.url), "utf8");
    expect(llms).toContain('"text"|"itext"|"natural"|"inatural"|"number"');
  });
});

/**
 * #221 (the "Related" batch). Several filters declare an OPTIONAL argument in
 * front of a required one. A positional call can only omit from the end, so
 * omitting the leading one slid every later argument a slot forward: the code
 * `fl.reduce(code)` type-checked and put the code in the initial-value slot, and
 * the engine refused the call at runtime with an argument-count error. The eight
 * argument counts here are probed, not declared — `vendor/filters-leading-required
 * .json`, written by `scripts/probe-lambda-bindings.ts`.
 */
describe("leading-optional argument slotting (#221)", () => {
  /** The engine-required count for each affected filter, as probed. */
  const PROBED: Record<string, number> = {
    reduce: 2,
    array_fill: 2,
    encrypt: 3,
    decrypt: 3,
    crypto_jws_encode: 3,
    crypto_jws_decode: 3,
    crypto_jwe_encode: 4,
    crypto_jwe_decode: 4,
  };

  it("requires every argument the engine requires", () => {
    for (const [name, count] of Object.entries(PROBED)) {
      expect(FILTER_REQUIRED_ARGS[name], name).toBe(count);
    }
  });

  it("Covers #221: fl.reduce cannot be called with the code alone", () => {
    // @ts-expect-error -- one argument means the code lands in the initial-value slot
    const misSlotted = fl.reduce(c.text("return $result + $this"));
    // What that call would have stored, and what the engine refuses: one
    // argument, in the wrong slot. The type is what stops it being written.
    expect(misSlotted.arg).toHaveLength(1);
    // The positional call that IS well-formed keeps the slots in order.
    expect(fl.reduce(0, c.text("return $result + $this")).arg).toEqual([
      c.int(0),
      c.text("return $result + $this"),
    ]);
  });

  it("Covers #221 Related: the named form places each argument in its own slot", () => {
    const named = fl.crypto_jws_encode({ headers: c.obj({}), key: "secret", algorithm: "HS256" });
    expect(named.arg).toEqual([c.obj({}), c.text("secret"), c.text("HS256")]);
    // …and encodes identically to the positional call.
    expect(named).toEqual(fl.crypto_jws_encode(c.obj({}), "secret", "HS256"));
  });

  it("gives every affected filter a named form that slots correctly", () => {
    const cases: Array<[unknown, unknown[]]> = [
      [fl.reduce({ initial_value: 0, code: "return $result + $this" }), [c.int(0), c.text("return $result + $this")]],
      [fl.array_fill({ start: 0, count: 3 }), [c.int(0), c.int(3)]],
      [fl.encrypt({ algorithm: "aes-256-ctr", key: "k", iv: "iv" }), [c.text("aes-256-ctr"), c.text("k"), c.text("iv")]],
      [fl.decrypt({ algorithm: "aes-256-ctr", key: "k", iv: "iv" }), [c.text("aes-256-ctr"), c.text("k"), c.text("iv")]],
      [fl.crypto_jws_decode({ check_claims: c.obj({}), key: "k", algorithm: "HS256" }), [c.obj({}), c.text("k"), c.text("HS256")]],
      [
        fl.crypto_jwe_encode({ headers: c.obj({}), key: "k", key_algorithm: "A128KW", content_algorithm: "A128CBC-HS256" }),
        [c.obj({}), c.text("k"), c.text("A128KW"), c.text("A128CBC-HS256")],
      ],
      [
        fl.crypto_jwe_decode({ check_claims: c.obj({}), key: "k", key_algorithm: "A128KW", content_algorithm: "A128CBC-HS256" }),
        [c.obj({}), c.text("k"), c.text("A128KW"), c.text("A128CBC-HS256")],
      ],
    ];
    for (const [built, expected] of cases) {
      expect((built as { arg: unknown[] }).arg).toEqual(expected);
    }
  });

  it("keeps a trailing optional argument omittable in both forms", () => {
    expect(fl.reduce(0, c.text("return 1")).arg).toHaveLength(2);
    expect(fl.reduce({ initial_value: 0, code: c.text("return 1") }).arg).toHaveLength(2);
    expect(fl.reduce({ initial_value: 0, code: c.text("return 1"), timeout: 30 }).arg).toHaveLength(3);
  });

  it("leaves filters without a leading optional exactly as they were", () => {
    expect(fl.get("a.b").arg).toEqual([c.text("a.b")]);
    expect(fl.get("a.b", 0).arg).toEqual([c.text("a.b"), c.int(0)]);
    expect(fl.map(c.text("return $this")).arg).toEqual([c.text("return $this")]);
    // The array filters the `path`-optional probe relaxed still take no argument.
    expect(fl.filter_null().arg).toEqual([]);
  });

  it("tells an argument object apart from an object-valued argument", () => {
    // `c.obj(...)` is a tagged value, so it is a positional argument — not an
    // argument object — even though it is object-shaped.
    expect(fl.get(c.obj({ a: 1 })).arg).toEqual([c.obj({ a: 1 })]);
  });

  /**
   * The drift guard. A spec refresh that introduces another leading-optional
   * filter must not silently reintroduce the class: either the engine-probed
   * count covers it, or this fails until someone probes it.
   */
  it("classifies every leading-optional filter in the catalog", () => {
    const unclassified: string[] = [];
    for (const [name, spec] of Object.entries(FILTER_SPECS)) {
      const args = spec.args ?? [];
      const lastRequired = args.reduce((acc, a, i) => (a.optional ? acc : i), -1);
      const firstOptional = args.findIndex((a) => a.optional);
      if (firstOptional === -1 || lastRequired < firstOptional) continue;
      // An optional argument sits in front of a required one: the count must say
      // so, or the positional form can still mis-slot.
      if ((FILTER_REQUIRED_ARGS[name] ?? 0) <= firstOptional) unclassified.push(name);
    }
    expect(unclassified).toEqual([]);
  });
});

describe("filter() argument holes (#221)", () => {
  it("refuses an omitted argument with a supplied one after it", () => {
    let message = "";
    try {
      filter("reduce", undefined, c.text("return $result"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("argument 1 is omitted");
    expect(message).toContain("issue #221");
  });

  it("still drops omitted TRAILING arguments, which is how absence is spelled", () => {
    expect(filter("trim", undefined).arg).toEqual([]);
    expect(filter("round", c.int(2), undefined).arg).toEqual([c.int(2)]);
  });
});
