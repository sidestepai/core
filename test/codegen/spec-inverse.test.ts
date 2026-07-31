/**
 * U5 — spec-inverse statement decoder.
 *
 * The headline test drives the **whole** `GENERATED_SPECS` catalog, not a sample:
 * synthesize an authored record for every spec, encode it, decode the result back
 * to source, evaluate that source against the real `s` namespace, and re-encode.
 * A spec regeneration that breaks invertibility fails here rather than quietly
 * degrading a pulled workspace into `raw()` output.
 */
import { describe, it, expect } from "vitest";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import type { StatementSpec } from "../../src/statements/schema-dsl/interpret.js";
import { STATEMENT_SURFACES } from "../../src/statements/surfaces.js";
import { s } from "../../src/statements/s.js";
import { and, cmp, expr, or } from "../../src/statements/expression.js";
import { encodeStatement } from "../../src/statements/statement.js";
import type { Statement } from "../../src/statements/statement.js";
import type { StackItemXdo } from "../../src/types/xdo.js";
import { filledContext, normalize } from "../../src/validate/normalize.js";
import { c, col, auth, env, inp, out, ref, setting, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { rawValue } from "../../src/values/raw-value.js";
import { raw } from "../../src/statements/special/raw.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeFromSpec } from "../../src/codegen/spec-inverse.js";
import { decodeStatement } from "../../src/codegen/statement.js";

const REFS = RefIndex.fromPayload({}, new DecodeContext());

/** Evaluate emitted statement source against the real authoring surface. */
function evaluate(source: string): Statement {
  const fn = new Function(
    "s", "c", "ref", "inp", "col", "auth", "env", "setting", "out",
    "withFilters", "fl", "rawValue", "raw", "expr", "cmp", "and", "or",
    `return (${source});`,
  );
  return fn(s, c, ref, inp, col, auth, env, setting, out, withFilters, fl, rawValue, raw, expr, cmp, and, or) as Statement;
}

/** A plausible authored record for a spec, covering every one of its rules. */
function synthesize(spec: StatementSpec): Record<string, unknown> {
  const authored: Record<string, unknown> = {};
  for (const rule of spec.rules) {
    switch (rule.type) {
      case "string":
        authored[rule.field] = rule.default ?? (rule.route.kind === "as" ? "result" : "x");
        break;
      case "value":
        authored[rule.field] = c.text("v");
        break;
      case "comparison":
        authored[rule.field] = { left: ref("item"), op: "=", right: c.int(1) };
        break;
    }
  }
  return authored;
}

/** Encode a synthesized spec statement to its stored form. */
function encodeSpec(spec: StatementSpec, overrides: Record<string, unknown> = {}): StackItemXdo {
  const factory = getFactory(spec.name);
  return encodeStatement(factory({ ...synthesize(spec), ...overrides }));
}

/** The `s.` leaf for a stored name (first surface, deterministically). */
function getFactory(storedName: string): (a: Record<string, unknown>) => Statement {
  const surface = STATEMENT_SURFACES.filter(([, stored]) => stored === storedName)
    .map(([key]) => key.replace(/^stack\|/, ""))
    .sort()[0]!;
  const leaf = surface
    .split(".")
    .reduce<any>((node, key) => node?.[key], s as any);
  return leaf as (a: Record<string, unknown>) => Statement;
}

/** Decode a stored statement through the spec arm alone. */
function decodeSpec(stored: StackItemXdo): { source: string | null; ctx: DecodeContext } {
  const ctx = new DecodeContext();
  const expr = decodeFromSpec(ctx, stored);
  return { source: expr ? printExpr(expr) : null, ctx };
}

/**
 * Specs whose rules include a comparison tree.
 *
 * These were parked when the spec arm shipped — the `{expression: […]}` inverse
 * lived only in the specials decoders. It is now shared (`codegen/expression.ts`),
 * so they invert like every other route and are no longer excluded below.
 */
const COMPARISON_SPECS = new Set(
  GENERATED_SPECS.filter((spec) => spec.rules.some((r) => r.route.kind === "context-compare")).map(
    (spec) => spec.name,
  ),
);

/** The whole catalog — no route kind is exempt from the identity check. */
const INVERTIBLE = GENERATED_SPECS;

describe("decodeFromSpec — whole-catalog invertibility", () => {
  it.each(INVERTIBLE.map((spec) => [spec.name, spec] as const))(
    "round-trips %s through encode → decode → encode",
    (_name, spec) => {
      const stored = encodeSpec(spec);
      const { source } = decodeSpec(stored);
      expect(source, "no decode produced").not.toBeNull();
      expect(normalize(encodeStatement(evaluate(source!))), `source: ${source}`).toEqual(
        normalize(stored),
      );
    },
  );

  it("covers the great majority of the catalog", () => {
    // A guard on the guard: if `INVERTIBLE` ever collapses to a handful, the
    // table above would still pass while proving almost nothing.
    expect(INVERTIBLE.length).toBeGreaterThan(140);
  });

  it("inverts comparison-tree specs through the shared expression algebra", () => {
    // The predicate-taking statements (`array.find`/`filter`/`every`, …). They
    // are covered by the table above too; asserted separately because they were
    // the one route kind the spec arm could not read, and a regression there
    // would silently cost readability rather than fidelity.
    expect(COMPARISON_SPECS.size).toBeGreaterThan(0);
    for (const name of COMPARISON_SPECS) {
      const spec = GENERATED_SPECS.find((x) => x.name === name)!;
      const { source } = decodeSpec(encodeSpec(spec));
      expect(source, name).not.toBeNull();
      expect(source, name).toContain("expr(");
    }
  });
});

describe("decodeFromSpec — route inversion", () => {
  it("partitions a context-spread from its sibling context-plain keys", () => {
    const spec = GENERATED_SPECS.find((x) => x.name === "mvp:create_attachment")!;
    expect(spec.rules.some((r) => r.route.kind === "context-spread")).toBe(true);
    const stored = encodeSpec(spec);
    const { source } = decodeSpec(stored);
    expect(source).not.toBeNull();
    expect(normalize(encodeStatement(evaluate(source!)))).toEqual(normalize(stored));
  });

  it("round-trips an argNameIsVar statement", () => {
    const spec = GENERATED_SPECS.find((x) => x.name === "mvp:array_push")!;
    const stored = encodeSpec(spec);
    const { source } = decodeSpec(stored);
    expect(normalize(encodeStatement(evaluate(source!)))).toEqual(normalize(stored));
  });

  it("omits a field sitting at its rule default and emits one that differs", () => {
    const spec = GENERATED_SPECS.find(
      (x) => x.rules.some((r) => r.type === "string" && r.default !== undefined && r.route.kind !== "as"),
    )!;
    const rule = spec.rules.find(
      (r) => r.type === "string" && r.default !== undefined && r.route.kind !== "as",
    )!;

    const atDefault = decodeSpec(encodeSpec(spec)).source!;
    expect(atDefault, `${spec.name}.${rule.field}`).not.toContain(`${rule.field}:`);

    const changed = decodeSpec(encodeSpec(spec, { [rule.field]: "not-the-default" })).source!;
    expect(changed).toContain(`${rule.field}:`);
    expect(normalize(encodeStatement(evaluate(changed)))).toEqual(
      normalize(encodeSpec(spec, { [rule.field]: "not-the-default" })),
    );
  });

  it("emits an authored description when the spec's envelope carries one", () => {
    const spec = GENERATED_SPECS.find((x) => x.envelope?.description && !COMPARISON_SPECS.has(x.name))!;
    const stored = encodeSpec(spec, { description: "why this exists" });
    const { source } = decodeSpec(stored);
    expect(source).toContain("why this exists");
    expect(normalize(encodeStatement(evaluate(source!)))).toEqual(normalize(stored));
  });

  it("emits a customized output envelope and omits the default one", () => {
    const spec = GENERATED_SPECS.find((x) => x.output && !COMPARISON_SPECS.has(x.name))!;
    expect(decodeSpec(encodeSpec(spec)).source).not.toContain("output:");
    const stored = encodeSpec(spec, { output: { customize: true } });
    const { source } = decodeSpec(stored);
    expect(source).toContain("output:");
    expect(normalize(encodeStatement(evaluate(source!)))).toEqual(normalize(stored));
  });
});

describe("decodeFromSpec — refusing to guess", () => {
  it("falls through when a required field is missing from the stored object", () => {
    const spec = GENERATED_SPECS.find((x) =>
      x.rules.some((r) => !r.optional && r.default === undefined && r.route.kind === "input"),
    )!;
    const stored = { ...encodeSpec(spec), input: [] };
    expect(decodeSpec(stored).source).toBeNull();
  });

  it("falls through when a stored context key no rule accounts for is present", () => {
    const spec = GENERATED_SPECS.find((x) => x.name === "mvp:math_add")!;
    const stored = encodeSpec(spec);
    const mutated = {
      ...stored,
      context: { ...(stored.context as object), unaccounted_key: "surprise" },
    };
    expect(decodeSpec(mutated).source).toBeNull();
  });

  it("falls through when a stored value differs from what the call re-encodes", () => {
    const spec = GENERATED_SPECS.find((x) => x.name === "mvp:math_add")!;
    const stored = encodeSpec(spec);
    // A near-miss the total-coverage gate alone would not catch: every key is
    // still accounted for, but one carries a tag no authored form produces.
    const input = (stored.input as Array<Record<string, unknown>>).map((e, i) =>
      i === 0 ? { ...e, tag: "trycatch" } : e,
    );
    const mutated = { ...stored, input };
    const { source } = decodeSpec(mutated);
    if (source !== null) {
      expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(mutated));
    }
  });

  it("does not resolve a stored name with two distinct public surfaces by lookup", () => {
    // `mvp:function` reaches both `function.run` and `service.function.run`,
    // which are different factories with different context shapes. Picking one
    // by name would re-encode the wrong shape.
    const surfaces = STATEMENT_SURFACES.filter(([, stored]) => stored === "mvp:function");
    expect(surfaces.map(([key]) => key).sort()).toEqual(["function.run", "service.function.run"]);

    // It is not spec-driven at all, so this arm declines it outright rather than
    // picking whichever surface a name lookup happened to reach first.
    const stored = encodeStatement(s.function.run({ fn: "helper" }));
    expect(decodeSpec(stored).source).toBeNull();
  });

  it("keeps the two aliases of one factory decodable, unlike the ambiguous pair", () => {
    // `mvp:get_input` also has two surfaces, but they are aliases of a single
    // factory — so ambiguity is about the factory, not the name count.
    const aliases = STATEMENT_SURFACES.filter(([, stored]) => stored === "mvp:get_input");
    expect(aliases.length).toBe(2);
    const stored = encodeStatement(s.util.get_raw_input({}));
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, REFS, stored));
    expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
  });
});

describe("dispatch", () => {
  it("prefers the spec arm and falls back to raw() for an unmodelled statement", () => {
    const ctx = new DecodeContext();
    const spec = GENERATED_SPECS.find((x) => x.name === "mvp:math_add")!;
    expect(printExpr(decodeStatement(ctx, REFS, encodeSpec(spec)))).toContain("s.math.add");
    expect(ctx.report.entries).toEqual([]);

    const unknown = { name: "mvp:not_in_any_catalog", context: {} } as unknown as StackItemXdo;
    expect(printExpr(decodeStatement(ctx, REFS, unknown))).toContain("raw(");
    expect(ctx.report.entries[0]!.category).toBe("raw-fallback");
  });

  it("leaves no imports or report entries behind from a discarded attempt", () => {
    const ctx = new DecodeContext();
    ctx.beginFile();
    // A statement whose spec exists but cannot be inverted must not leave the
    // value decoder's imports (or its problems) in the committed file. Built by
    // corrupting the comparison tree of a spec whose OTHER rule is a value —
    // so an import is genuinely recorded before the decode fails, which is the
    // only way this assertion can catch a missing rollback.
    const spec = GENERATED_SPECS.find(
      (x) =>
        COMPARISON_SPECS.has(x.name) &&
        x.rules.some((r) => r.route.kind === "context-nest") &&
        x.rules.some((r) => r.route.kind === "context-compare"),
    )!;
    const comparePath = (
      spec.rules.find((r) => r.route.kind === "context-compare")!.route as { path: string }
    ).path;
    const stored = encodeSpec(spec);
    const broken = {
      ...stored,
      context: { ...(stored.context as object), [comparePath]: { expression: "not-a-tree" } },
    } as StackItemXdo;

    decodeStatement(ctx, REFS, broken);
    const modules = ctx.imports.toStatements().map((i) => i.module);
    expect(modules).toEqual(["@sidestep/core/codegen"]);
    expect(ctx.report.entries.every((e) => e.category === "raw-fallback")).toBe(true);
  });
});

/**
 * An EMPTY `context` on a statement whose context IS its tagged value.
 *
 * The engine's optional-schema pass fills every absent member, so `{}` is one
 * stored spelling of a blank value at that statement's declared default tag —
 * 22 statements in the survey corpus stored it, one each, and all 22 fell back
 * to `raw()` on the same required-field guard. Live-verified across every
 * distinct tag by `scripts/probe-empty-context.ts`: `const`, `const:int`,
 * `const:decimal`, `const:array` and `input` each behave identically to the
 * filled form.
 */
describe("an empty context is the members the engine fills in", () => {
  /** The stored shape a workspace holds for one of these. */
  function storedEmpty(name: string): StackItemXdo {
    return {
      name,
      addon: [],
      input: [],
      output: { items: [], filters: [], customize: false },
      context: {},
      disabled: false,
      description: "",
      settings_registry: null,
    } as unknown as StackItemXdo;
  }

  // One per distinct default tag, which is what the live probe covered.
  for (const name of [
    "mvp:text_append", // const
    "mvp:math_sub", // const:decimal
    "mvp:math_mod", // const:int
    "mvp:array_merge", // const:array
    "mvp:setheader", // input
    "mvp:die", // input, unnamed
    "mvp:sleep", // const:int, unnamed
  ]) {
    it(`decodes ${name} instead of falling back to raw()`, () => {
      const stored = storedEmpty(name);
      const source = printExpr(decodeStatement(new DecodeContext(), REFS, stored));
      expect(source).not.toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
    });
  }

  it("keeps the fill in step with each spec's actual rules", () => {
    // The self-guard. `array_pop`/`array_shift` USE no value — their specs route
    // no spread field — so filling one invents members the encoder can never
    // produce, and the comparison then demands them forever. That shipped once
    // and this is what catches it next time.
    let covered = 0;
    for (const spec of GENERATED_SPECS) {
      const stored = storedEmpty(spec.name);
      const fill = filledContext(stored) as Record<string, unknown> | null;
      if (!fill) continue; // not in the table — nothing to keep in step
      covered++;

      const hasSpread = spec.rules.some((r) => r.route.kind === "context-spread");
      expect(hasSpread, `${spec.name} is filled but routes no spread value`).toBe(true);

      // `name` belongs in the fill exactly when the spec routes one, or the
      // comparison demands a member the encoder never writes.
      const routesName = spec.rules.some(
        (r) => r.field === "name" && r.route.kind === "context-plain",
      );
      expect("name" in fill, `${spec.name} fill/spec disagree on \`name\``).toBe(routesName);

      // And it must actually round-trip through the real factory.
      const source = printExpr(decodeStatement(new DecodeContext(), REFS, stored));
      expect(source, `${spec.name} fill fell back`).not.toContain("raw(");
      expect(
        normalize(encodeStatement(evaluate(source))),
        `${spec.name} fill does not round-trip`,
      ).toEqual(normalize(stored));
    }
    expect(covered, "the fill table covers no spec — it silently stopped matching").toBeGreaterThan(20);
  });
});
