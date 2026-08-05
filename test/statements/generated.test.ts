import { describe, it, expect } from "vitest";
import {
  mathAdd,
  bitwiseAnd,
  objectKeys,
  GENERATED_STATEMENT_NAMES,
} from "../../src/statements/generated/catalog.js";
import { generated } from "../../src/statements/generated/factories.generated.js";
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

  /** The golden's inline array: `[]` grown by one `array_push` per element. */
  const inlineArray = (...ints: number[]) =>
    withFilters(
      c.array([]),
      ints.map((n) => filter("array_push", c.int(n))),
    );

  it("array_find deep-equals the persisted fixture WHOLE-OBJECT", () => {
    // Whole-object, not just the compare slice. The inline-array filter args are
    // the reason it used to be sliced: the golden stores each `const:int` arg as
    // a JSON NUMBER (`1`) while the SDK writes the declared string (`"1"`).
    //
    // That is a storage-vintage artifact, not a divergence. The engine's own
    // filter-arg schema declares `arg[].value` as TEXT, and its text coercion
    // casts a non-string scalar to its string form before anything reads it — so
    // `1` and `"1"` are one stored value, and the string is the form a
    // schema-validated write persists. `normalize()` already canonicalizes the
    // numeric spelling for exactly this reason, which makes the full object
    // comparable and leaves nothing for a slice to protect.
    const fixture = loadFixture("statements/array_find.json");
    const encoded = encodeStatement(
      getStatementFactory("mvp:array_find")({
        as: "test",
        expr: inlineArray(1, 2, 3),
        if: expr(ref("$this"), "=", c.int(1)),
      }),
    );
    expect(normalize(encoded)).toEqual(normalize(fixture));
  });

  it("array_every encodes identically to array_find apart from the statement name", () => {
    // The two share one generated spec (same three rules, same routes), so the
    // array_find golden pins array_every's shape too. Asserted rather than
    // assumed: a spec regeneration that drifted one and not the other would
    // otherwise pass unnoticed until an import failed.
    const args = {
      as: "test",
      expr: inlineArray(1, 2, 3),
      if: expr(ref("$this"), "=", c.int(1)),
    };
    const every = encodeStatement(getStatementFactory("mvp:array_every")({ ...args }));
    const find = encodeStatement(getStatementFactory("mvp:array_find")({ ...args }));
    expect(normalize({ ...every, name: "mvp:array_find" })).toEqual(normalize(find));
  });

  it("object_values nests an INLINE-ARRAY source the same way as its json_decode golden", () => {
    // The worklist tracked a separate `object_values-array` golden. Like
    // `return-null-text`, it does not need one: `context.object` is a
    // context-nest of one tagged value, so the golden fixes the envelope and the
    // inline-array triple it would carry is itself pinned by the array_find
    // golden asserted above. This composes the two proven halves.
    const golden = loadFixture<{ context: { object: unknown } }>("statements/object_values.json");
    const encoded = encodeStatement(
      getStatementFactory("mvp:object_values")({ as: "x2", value: inlineArray(1, 2, 3) }),
    ) as { context: { object: unknown } };
    const arrayGolden = loadFixture<{ context: { array: unknown } }>("statements/array_find.json");
    expect(normalize(encoded.context.object)).toEqual(normalize(arrayGolden.context.array));
    expect(Object.keys(normalize(encoded.context) as object)).toEqual(
      Object.keys(normalize(golden.context) as object),
    );
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

  it("honours a description on a lean statement, whose envelope profile has none", () => {
    // The envelope profile decides whether an EMPTY description is emitted by
    // default — a byte detail pinned per statement from its golden. It does not
    // decide whether one can be authored: `description` annotates the stack item,
    // `encodeStatement` writes the member for every statement, and the editor
    // offers the note on all of them. Two real `mvp:array_push` statements in a
    // 177-workspace sweep carry a non-empty one, so dropping it here discarded
    // authored data that the engine does store on lean statements.
    const mathAddFactory = getStatementFactory("mvp:math_add");
    const encoded = encodeStatement(
      mathAddFactory({ name: "x1", value: c.int(1), description: "why this step" }),
    );
    expect(encoded.description).toBe("why this step");
  });

  it("still defaults to the empty description when none is authored", () => {
    const mathAddFactory = getStatementFactory("mvp:math_add");
    const encoded = encodeStatement(mathAddFactory({ name: "x1", value: c.int(1) }));
    expect(encoded.description).toBe("");
  });
});

describe("enum-constrained field signatures", () => {
  it("accepts the bare literal spelling", () => {
    const encoded = encodeStatement(generated.ai.external.mcp.tool.run({ connection_type: "stream" }));
    expect(encoded.input).toContainEqual(
      expect.objectContaining({ name: "connection_type", value: "stream", tag: "const" }),
    );
  });

  it("still accepts the explicit Value spelling", () => {
    const encoded = encodeStatement(
      generated.ai.external.mcp.tool.run({ connection_type: c.text("stream") }),
    );
    expect(encoded.input).toContainEqual(
      expect.objectContaining({ name: "connection_type", value: "stream", tag: "const" }),
    );
  });

  it("rejects a wrong literal at compile time AND at encode time", () => {
    expect(() =>
      // @ts-expect-error "streaming" is not one of the engine's two legal values
      generated.ai.external.mcp.tool.run({ connection_type: "streaming" }),
    ).toThrow(/accepts only "sse" \| "stream"/);
  });

  it("keeps the dynamic escape hatch open at compile time", () => {
    // A ref must remain assignable — the union is additive, never a narrowing
    // of what the field could already take.
    const encoded = encodeStatement(
      generated.ai.external.mcp.tool.run({ connection_type: ref("cfg.mode") }),
    );
    expect(encoded.input).toContainEqual(
      expect.objectContaining({ name: "connection_type", value: "cfg.mode", tag: "var" }),
    );
  });

  it("renders values carrying spaces and punctuation as usable literals", () => {
    // The generated union is only useful if these survive quoting intact.
    const withSpace = encodeStatement(generated.cloud.elasticsearch.query({ auth_type: "API Key" }));
    expect(withSpace.input).toContainEqual(
      expect.objectContaining({ name: "auth_type", value: "API Key" }),
    );
    const withPunct = encodeStatement(
      generated.security.jwe_encode({ key_algorithm: "ECDH-ES+A128KW" }),
    );
    expect(withPunct.input).toContainEqual(
      expect.objectContaining({ name: "key_algorithm", value: "ECDH-ES+A128KW" }),
    );
  });

  it("leaves an unconstrained field on the same statement taking any Value", () => {
    const encoded = encodeStatement(
      generated.ai.external.mcp.tool.run({ tool: c.text("anything-at-all") }),
    );
    expect(encoded.input).toContainEqual(
      expect.objectContaining({ name: "tool_name", value: "anything-at-all" }),
    );
  });
});
