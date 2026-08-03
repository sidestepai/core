/**
 * U2 — deterministic source printer.
 *
 * Formatting is a property of *construction*, not of a width heuristic: a node
 * breaks across lines because of what it is (a non-empty object/array, or a call
 * carrying one), never because of how many columns it measured. That keeps output
 * byte-identical run to run, which the generated-tree tests depend on.
 */
import { describe, it, expect } from "vitest";
import { arr, arrow, call, id, lit, obj, printExpr, printModule } from "../../src/codegen/print.js";

describe("printExpr", () => {
  it("renders leaf calls inline", () => {
    expect(printExpr(call("c.int", lit(1)))).toBe("c.int(1)");
    expect(printExpr(call("c.text", lit("hello")))).toBe('c.text("hello")');
    expect(printExpr(call("ref", lit("user"), lit("id")))).toBe('ref("user", "id")');
  });

  it("renders empty composites inline and non-empty ones multiline", () => {
    expect(printExpr(obj([]))).toBe("{}");
    expect(printExpr(arr([]))).toBe("[]");
    expect(printExpr(obj([["a", lit(1)]]))).toBe("{\n  a: 1,\n}");
    expect(printExpr(arr([lit(1)]))).toBe("[\n  1,\n]");
  });

  it("indents a nested object literal correctly at depth 3+", () => {
    const node = obj([
      ["level1", obj([["level2", obj([["level3", arr([lit("deep")])]])]])],
    ]);
    expect(printExpr(node)).toBe(
      [
        "{",
        "  level1: {",
        "    level2: {",
        "      level3: [",
        '        "deep",',
        "      ],",
        "    },",
        "  },",
        "}",
      ].join("\n"),
    );
  });

  it("breaks a call whose argument is itself multiline", () => {
    expect(printExpr(call("s.db.get", obj([["table", id("users")]])))).toBe(
      ["s.db.get({", "  table: users,", "})"].join("\n"),
    );
  });

  it("quotes object keys only when they are not valid identifiers", () => {
    expect(printExpr(obj([["ok_key$", lit(1)], ["not-ok", lit(2)], ["2digits", lit(3)]]))).toBe(
      ['{', '  ok_key$: 1,', '  "not-ok": 2,', '  "2digits": 3,', '}'].join("\n"),
    );
  });

  it("escapes strings so the emitted literal parses back to the original", () => {
    const nasty = 'quote " backslash \\ newline \n tab \t unicode ü 漢 emoji 🎉';
    const printed = printExpr(lit(nasty));
    expect(JSON.parse(printed)).toBe(nasty);
    expect(printed).not.toContain("\n");
  });

  it("renders JSON scalars without collapsing falsy values", () => {
    expect(printExpr(lit(null))).toBe("null");
    expect(printExpr(lit(false))).toBe("false");
    expect(printExpr(lit(0))).toBe("0");
    expect(printExpr(lit(""))).toBe('""');
  });

  it("renders nested plain data inside a literal deterministically", () => {
    expect(printExpr(lit({ b: 1, a: [2, { c: null }] }))).toBe(
      ["{", "  b: 1,", "  a: [", "    2,", "    {", "      c: null,", "    },", "  ],", "}"].join(
        "\n",
      ),
    );
  });

  it("is deterministic — identical input renders byte-identical twice", () => {
    const node = obj([["z", arr([lit(1), call("c.text", lit("x"))])], ["a", id("handle")]]);
    expect(printExpr(node)).toBe(printExpr(node));
  });

  it("renders an arrow with an empty body inline", () => {
    expect(printExpr(arrow(["t"], arr([])))).toBe("(t) => []");
  });

  it("renders an arrow with a multiline body closing at the arrow's own depth", () => {
    expect(printExpr(arrow(["t"], arr([call("s.db.edit", obj([["as", lit("x")]]))])))).toBe(
      ["(t) => [", "  s.db.edit({", "    as: \"x\",", "  }),", "]"].join("\n"),
    );
  });

  it("indents a nested arrow against its parent, not the module root", () => {
    // The reason `arrow` is a node rather than pre-printed text spliced into
    // `id()`: a body rendered at depth 0 would close under column 0 here.
    expect(printExpr(obj([["stack", arrow(["t"], arr([id("first"), id("second")]))]]))).toBe(
      ["{", "  stack: (t) => [", "    first,", "    second,", "  ],", "}"].join("\n"),
    );
  });

  it("renders a scalar-bodied arrow and a multi-parameter arrow", () => {
    expect(printExpr(arrow(["t"], id("t.payload")))).toBe("(t) => t.payload");
    expect(printExpr(arrow(["a", "b"], lit(1)))).toBe("(a, b) => 1");
  });

  it("is deterministic for arrow nodes", () => {
    const node = arrow(["t"], arr([call("s.set", id("t.new"))]));
    expect(printExpr(node)).toBe(printExpr(node));
  });
});

describe("printModule", () => {
  it("renders imports, comments, consts, and a default export", () => {
    expect(
      printModule([
        { kind: "comment", text: "Generated from bundle." },
        { kind: "import", module: "@sidestep/core", symbols: ["s", "c"] },
        { kind: "blank" },
        { kind: "const", name: "signup", exported: true, value: call("defineFunction", obj([])) },
        { kind: "blank" },
        { kind: "exportDefault", value: id("signup") },
      ]),
    ).toBe(
      [
        "// Generated from bundle.",
        'import { c, s } from "@sidestep/core";',
        "",
        "export const signup = defineFunction({});",
        "",
        "export default signup;",
        "",
      ].join("\n"),
    );
  });

  it("renders a multi-line comment as consecutive line comments", () => {
    expect(printModule([{ kind: "comment", text: "line one\nline two" }])).toBe(
      "// line one\n// line two\n",
    );
  });

  it("renders a type-only import", () => {
    expect(
      printModule([{ kind: "import", module: "@sidestep/core", symbols: ["Value"], typeOnly: true }]),
    ).toBe('import type { Value } from "@sidestep/core";\n');
  });
});
