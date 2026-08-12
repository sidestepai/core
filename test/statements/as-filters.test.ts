/**
 * `asFilters` — a filter chain piped onto a statement's result before it binds.
 *
 * The editor shows it as `return as token | upper`; the engine stores it in the
 * statement envelope's `output.filters`, in the same `{name, disabled, arg[]}`
 * shape as a value filter. It is an argument of the `as` clause itself, so every
 * statement that binds a variable accepts one — the generated arm below is
 * exhaustive by construction over the catalog, matching `annotations.test.ts`.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import { GENERATED_SPECS } from "../../src/statements/generated/specs.generated.js";
import { encodeFromSpec } from "../../src/statements/schema-dsl/interpret.js";
import { encodeStatement } from "../../src/statements/statement.js";
import type { Statement } from "../../src/statements/statement.js";
import { s } from "../../src/statements/s.js";
import { c, inp } from "../../src/values/value.js";
import { expr } from "../../src/statements/expression.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";

const UPPER = fl.upper();

/** Arguments satisfying a spec's declared rules — enough to build, nothing more. */
function argsFor(spec: (typeof GENERATED_SPECS)[number]): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  for (const rule of spec.rules) {
    if (rule.optional || rule.default !== undefined) continue;
    a[rule.field] =
      rule.type === "string"
        ? "x"
        : rule.type === "comparison"
          ? expr(c.text("a"), "=", c.text("a"))
          : c.text(rule.enum ? rule.enum[0]! : "x");
  }
  return a;
}

/** The stored `output` block, read back off the encoded envelope. */
function storedOutput(stmt: Statement): Record<string, unknown> {
  return (encodeStatement(stmt) as unknown as { output: Record<string, unknown> }).output;
}

const users = table({
  name: "users",
  schema: { id: f.int(), email: f.text(), name: f.text() },
});

describe("asFilters — generated catalog", () => {
  it("every statement that binds an `as` carries the chain into output.filters", () => {
    const dropped: string[] = [];
    for (const spec of GENERATED_SPECS) {
      if (!spec.rules.some((r) => r.route.kind === "as")) continue;
      const stmt = encodeFromSpec(spec, { ...argsFor(spec), as: "x", asFilters: [UPPER] });
      const filters = storedOutput(stmt).filters as unknown[];
      if (!Array.isArray(filters) || filters.length !== 1) dropped.push(spec.name);
    }
    expect(dropped, `statements that dropped asFilters: ${dropped.join(", ")}`).toEqual([]);
  });

  it("encodes the chain in the engine's filter shape", () => {
    const stmt = s.security.create_uuid({ as: "token", asFilters: [UPPER] });
    expect(storedOutput(stmt)).toEqual({
      items: [],
      customize: false,
      filters: [{ name: "upper", disabled: false, arg: [] }],
    });
  });

  it("carries a filter's arguments through verbatim", () => {
    const stmt = s.security.create_uuid({ as: "token", asFilters: [fl.substr(c.int(0), c.int(5))] });
    const [only] = storedOutput(stmt).filters as { name: string; arg: unknown[] }[];
    expect(only!.name).toBe("substr");
    expect(only!.arg).toEqual([c.int(0), c.int(5)]);
  });

  it("preserves author order across a chain", () => {
    const stmt = s.security.create_uuid({ as: "token", asFilters: [fl.trim(), UPPER, fl.substr(c.int(0), c.int(4))] });
    const names = (storedOutput(stmt).filters as { name: string }[]).map((x) => x.name);
    expect(names).toEqual(["trim", "upper", "substr"]);
  });

  it("an empty chain is byte-identical to omitting it", () => {
    const withEmpty = encodeStatement(s.security.create_uuid({ as: "token", asFilters: [] }));
    const without = encodeStatement(s.security.create_uuid({ as: "token" }));
    expect(withEmpty).toEqual(without);
  });

  it("still emits a well-formed output block on a spec that declares none", () => {
    // `mvp:uuid4` carries no `output` in its spec, so the block comes from the
    // base envelope rather than the spec's own default.
    const withoutSpecOutput = GENERATED_SPECS.find((sp) => sp.name === "mvp:uuid4");
    expect(withoutSpecOutput?.output).toBeFalsy();
    expect(storedOutput(s.security.create_uuid({ as: "token", asFilters: [UPPER] }))).toEqual({
      items: [],
      customize: false,
      filters: [{ name: "upper", disabled: false, arg: [] }],
    });
  });
});

describe("asFilters — hand-written specials", () => {
  it("a positional/object special produces the same envelope as a generated one", () => {
    const special = s.db.get({
      table: users,
      fieldValue: inp("id"),
      as: "u",
      asFilters: [UPPER],
    });
    expect(storedOutput(special).filters).toEqual([{ name: "upper", disabled: false, arg: [] }]);
  });

  it("set_var takes the chain in its trailing options argument", () => {
    const stmt = s.set_var("greeting", c.text("hi"), { asFilters: [UPPER] });
    expect(storedOutput(stmt).filters).toEqual([{ name: "upper", disabled: false, arg: [] }]);
  });

  it("a column selection and a filter chain coexist in one output block", () => {
    const stmt = s.db.get({
      table: users,
      fieldValue: inp("id"),
      output: ["id", "email"],
      as: "u",
      asFilters: [UPPER],
    });
    const out = storedOutput(stmt);
    expect(out.filters).toEqual([{ name: "upper", disabled: false, arg: [] }]);
    expect(out.items).not.toEqual([]);
  });

  it("does not disturb the other annotations", () => {
    const encoded = encodeStatement(
      s.security.create_uuid({ as: "token", asFilters: [UPPER], disabled: true, description: "why" }),
    ) as unknown as Record<string, unknown>;
    expect(encoded.disabled).toBe(true);
    expect(encoded.description).toBe("why");
  });
});

describe("asFilters — guards", () => {
  it("refuses a statement that binds no `as`", () => {
    // Reached past the types the way a decoded tree or a JS caller would.
    const noBinding = GENERATED_SPECS.find(
      (sp) => !sp.rules.some((r) => r.route.kind === "as") && !sp.envelope?.emitAs,
    )!;
    expect(() => encodeFromSpec(noBinding, { ...argsFor(noBinding), asFilters: [UPPER] })).toThrow(
      /binds no `as` variable/,
    );
  });

  it("names the statement and the remedy when it refuses", () => {
    const noBinding = GENERATED_SPECS.find(
      (sp) => !sp.rules.some((r) => r.route.kind === "as") && !sp.envelope?.emitAs,
    )!;
    let message = "";
    try {
      encodeFromSpec(noBinding, { ...argsFor(noBinding), asFilters: [UPPER] });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(noBinding.name);
    expect(message).toContain("Bind the result with `as`");
  });

  it("refuses `asFilters` and `output.filters` together rather than picking one", () => {
    const withOutput = GENERATED_SPECS.find(
      (sp) => sp.output && sp.rules.some((r) => r.route.kind === "as"),
    )!;
    expect(() =>
      encodeFromSpec(withOutput, {
        ...argsFor(withOutput),
        as: "x",
        asFilters: [UPPER],
        output: { filters: [UPPER] },
      }),
    ).toThrow(/both set the same filter chain/);
  });

  it("leaves the reserved `output.filters` escape hatch working on its own", () => {
    const withOutput = GENERATED_SPECS.find(
      (sp) => sp.output && sp.rules.some((r) => r.route.kind === "as"),
    )!;
    const stmt = encodeFromSpec(withOutput, {
      ...argsFor(withOutput),
      as: "x",
      output: { filters: [UPPER] },
    });
    expect(storedOutput(stmt).filters).toEqual([UPPER]);
  });
});

describe("asFilters — round trip under the proof comparator", () => {
  it("a filtered binding does not compare equal to an unfiltered one", () => {
    // The regression this whole surface depends on: if `normalize` elided the
    // filters, every decode test below would pass while dropping them.
    const filtered = encodeStatement(s.security.create_uuid({ as: "token", asFilters: [UPPER] }));
    const plain = encodeStatement(s.security.create_uuid({ as: "token" }));
    expect(filtered).not.toEqual(plain);
  });

  it("is reachable on a db write that also selects columns", () => {
    const stmt = s.db.add({
      table: users,
      row: { email: c.text("a@b.c") },
      as: "created",
      asFilters: [fl.get(c.text("id"))],
    });
    expect(storedOutput(stmt).filters).toEqual([
      { name: "get", disabled: false, arg: [c.text("id")] },
    ]);
  });
});
