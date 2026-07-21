import { describe, it, expect } from "vitest";
import {
  mathAdd,
  bitwiseAnd,
  objectKeys,
  GENERATED_STATEMENT_NAMES,
} from "../../src/statements/generated/catalog.js";
import { encodeFromSpec } from "../../src/statements/schema-dsl/interpret.js";
import type { StatementSpec } from "../../src/statements/schema-dsl/interpret.js";
import { encodeStatement, getStatementFactory, isRegisteredStatement } from "../../src/statements/statement.js";
import { c, ref, filter, withFilters } from "../../src/values/value.js";
import { expr } from "../../src/statements/conditional.js";
import { normalize, loadFixture } from "../conformance/harness.js";

describe("schema-DSL interpreter — validated against persisted fixtures", () => {
  it("math_add deep-equals the real fixture", () => {
    const encoded = encodeStatement(mathAdd("x1", c.int(1)));
    expect(normalize(encoded)).toEqual(normalize(loadFixture("statements/math_add.json")));
  });

  it("bitwise_and deep-equals the real fixture", () => {
    const encoded = encodeStatement(bitwiseAnd("x9", c.int(123)));
    expect(normalize(encoded)).toEqual(normalize(loadFixture("statements/bitwise_and.json")));
  });

  it("object_keys deep-equals the real fixture (value nested under context.object)", () => {
    const value = withFilters(
      c.text('{"first_name":"first","last_name":"last"}'),
      [filter("json_decode")],
    );
    const encoded = encodeStatement(objectKeys("x2", value));
    expect(normalize(encoded)).toEqual(normalize(loadFixture("statements/object_keys.json")));
  });
});

describe("encodeFromSpec field-rule routing", () => {
  it("argNameIsVar family: name→context.name, value spread, output present", () => {
    const spec: StatementSpec = {
      name: "mvp:math_add",
      argNameIsVar: true,
      output: true,
      rules: [
        { field: "name", type: "string", optional: true, default: "", route: { kind: "context-plain", path: "name" } },
        { field: "value", type: "value", optional: false, route: { kind: "context-spread" } },
      ],
    };
    const stmt = encodeFromSpec(spec, { name: "x", value: c.int(5) });
    expect(stmt.context).toEqual({ name: "x", value: "5", tag: "const:int", filters: [] });
    expect(stmt.output).toEqual({ filters: [] });
    expect(stmt.as).toBeUndefined();
  });

  it("object family: as→top-level as, value nested under context.object", () => {
    const spec: StatementSpec = {
      name: "mvp:object_keys",
      output: true,
      rules: [
        { field: "as", type: "string", optional: true, route: { kind: "as" } },
        { field: "value", type: "value", optional: true, route: { kind: "context-nest", path: "object" } },
      ],
    };
    const stmt = encodeFromSpec(spec, { as: "out", value: c.text("x") });
    expect(stmt.as).toBe("out");
    // A context-nest value omits empty `filters` (persisted form); a populated
    // filter list is kept (see the array_find golden, context.object w/ json_decode).
    expect(stmt.context).toEqual({ object: { value: "x", tag: "const" } });
  });

  it("two assign sources route to distinct context keys (expect.to_equal family)", () => {
    const spec: StatementSpec = {
      name: "mvp:test_expect_to_equal",
      rules: [
        { field: "expr", type: "value", optional: true, default: "", route: { kind: "context-nest", path: "value1" } },
        { field: "value", type: "value", optional: true, default: "", route: { kind: "context-nest", path: "value2" } },
      ],
    };
    const stmt = encodeFromSpec(spec, { expr: c.int(1), value: c.int(2) });
    expect(stmt.context).toEqual({
      value1: { value: "1", tag: "const:int" },
      value2: { value: "2", tag: "const:int" },
    });
  });

  it("emits a string field's default when not provided (as?='' → as:'')", () => {
    const spec: StatementSpec = {
      name: "mvp:array_pop",
      rules: [
        { field: "name", type: "string", optional: true, default: "", route: { kind: "context-plain", path: "name" } },
        { field: "as", type: "string", optional: true, default: "", route: { kind: "as" } },
      ],
    };
    const stmt = encodeFromSpec(spec, { name: "mylist" });
    expect(stmt.as).toBe("");
    expect(stmt.context).toEqual({ name: "mylist" });
  });

  it("omits an optional value field that has no provided value", () => {
    const spec: StatementSpec = {
      name: "mvp:x",
      rules: [
        { field: "as", type: "string", optional: true, route: { kind: "as" } },
        { field: "value", type: "value", optional: true, default: "", route: { kind: "context-nest", path: "object" } },
      ],
    };
    const stmt = encodeFromSpec(spec, { as: "o" });
    expect(stmt.context).toEqual({});
    expect(stmt.as).toBe("o");
  });

  it("throws when a required field is missing", () => {
    const spec: StatementSpec = {
      name: "mvp:throw_error",
      rules: [{ field: "value", type: "value", optional: false, route: { kind: "context-spread" } }],
    };
    expect(() => encodeFromSpec(spec, {})).toThrow(/required field "value"/);
  });

  it("omits output when the spec does not set it", () => {
    const spec: StatementSpec = {
      name: "mvp:uuid4",
      rules: [{ field: "as", type: "string", optional: true, route: { kind: "as" } }],
    };
    const stmt = encodeFromSpec(spec, { as: "x5" });
    expect(stmt.output).toBeUndefined();
  });
});

describe("!inline:array + !compare directives (array-predicate family)", () => {
  it("registers the array-predicate family", () => {
    for (const name of [
      "mvp:array_find",
      "mvp:array_every",
      "mvp:array_filter",
      "mvp:array_has",
      "mvp:array_group_by",
      "mvp:array_partition",
    ]) {
      expect(isRegisteredStatement(name)).toBe(true);
    }
  });

  it("context-compare encodes the engine expression shape", () => {
    const spec: StatementSpec = {
      name: "mvp:array_find",
      rules: [{ field: "if", type: "comparison", optional: true, route: { kind: "context-compare", path: "expr" } }],
    };
    const stmt = encodeFromSpec(spec, { if: expr(ref("$this"), "=", c.int(1)) });
    expect(stmt.context).toEqual({
      expr: {
        expression: [
          {
            type: "statement",
            or: false,
            group: { expression: [] },
            statement: {
              op: "=",
              left: { operand: "$this", tag: "var", filters: [] },
              right: { operand: "1", tag: "const:int", filters: [] },
            },
          },
        ],
      },
    });
  });

  it("array_find's !compare output deep-equals the persisted fixture's context.expr", () => {
    // The comparison operands are byte-exact against the golden fixture; the
    // inline-array filter args use numeric values (a value-layer detail tracked
    // for the field-type unit), so only the compare slice is asserted here.
    const fixture = loadFixture<{ context: { expr: unknown } }>("statements/array_find.json");
    const encoded = encodeStatement(
      getStatementFactory("mvp:array_find")({ as: "test", if: expr(ref("$this"), "=", c.int(1)) }),
    );
    const ctx = (encoded as { context: { expr: unknown } }).context;
    expect(normalize(ctx.expr)).toEqual(normalize(fixture.context.expr));
  });

  it("context-nest stores an inline-array Value's fields under the target path", () => {
    const spec: StatementSpec = {
      name: "mvp:array_find",
      rules: [{ field: "expr", type: "value", optional: true, route: { kind: "context-nest", path: "array" } }],
    };
    const arrayValue = withFilters(c.array([]), [filter("array_push", c.int(1))]);
    const stmt = encodeFromSpec(spec, { expr: arrayValue });
    expect(stmt.context).toEqual({
      array: { value: "[]", tag: "const:array", filters: arrayValue.filters },
    });
  });
});

describe("generated catalog registration", () => {
  it("registers all generated statement names on the statement registry", () => {
    for (const name of GENERATED_STATEMENT_NAMES) {
      expect(isRegisteredStatement(name)).toBe(true);
    }
  });

  it("covers the validated families (math, bitwise, text, object, array, expect)", () => {
    for (const name of [
      "mvp:math_add",
      "mvp:bitwise_and",
      "mvp:text_append",
      "mvp:object_keys",
      "mvp:array_push",
      "mvp:test_expect_to_equal",
    ]) {
      expect(GENERATED_STATEMENT_NAMES).toContain(name);
    }
  });
});

describe("generated envelope authoring — description + output (U2)", () => {
  const apiRequest = getStatementFactory("mvp:api_request");

  it("emits an authored description when the envelope carries one", () => {
    const encoded = encodeStatement(apiRequest({ url: c.text("https://x"), description: "note" }));
    expect(encoded.description).toBe("note");
  });

  it("defaults description to empty when omitted (unchanged behavior)", () => {
    const encoded = encodeStatement(apiRequest({ url: c.text("https://x") }));
    expect(encoded.description).toBe("");
  });

  it("merges authored output filters/customize over the default output envelope", () => {
    const encoded = encodeStatement(
      apiRequest({
        url: c.text("https://x"),
        output: { customize: true, filters: [filter("json_decode")] },
      }),
    );
    expect(encoded.output).toEqual({
      items: [],
      filters: [filter("json_decode")],
      customize: true,
    });
  });

  it("leaves the empty default output when omitted (unchanged behavior)", () => {
    const encoded = encodeStatement(apiRequest({ url: c.text("https://x") }));
    expect(encoded.output).toEqual({ items: [], filters: [], customize: false });
  });

  it("ignores a description on a lean statement whose envelope has none", () => {
    // math_add has no `description` envelope flag; the reserved key is inert.
    const mathAddFactory = getStatementFactory("mvp:math_add");
    const encoded = encodeStatement(
      mathAddFactory({ name: "x1", value: c.int(1), description: "ignored" } as never),
    );
    // encodeStatement fills the uniform envelope default; the authored value is dropped.
    expect(encoded.description).toBe("");
  });
});
