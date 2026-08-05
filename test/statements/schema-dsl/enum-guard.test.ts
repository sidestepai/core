import { describe, it, expect } from "vitest";
import { encodeFromSpec } from "../../../src/statements/schema-dsl/interpret.js";
import type { Authored, StatementSpec } from "../../../src/statements/schema-dsl/interpret.js";
import { encodeStatement, getStatementFactory } from "../../../src/statements/statement.js";
// Side-effect import: populates the statement registry the lookups below use.
import "../../../src/statements/generated/catalog.js";
import { c, ref, inp, filter, withFilters } from "../../../src/values/value.js";

/**
 * U4 — the encode-time enum guard.
 *
 * The risk here is OVER-rejection, not under-rejection: a guard that refuses a
 * value some real workspace legitimately stores turns a working pull/push cycle
 * into a hard failure. The accept cases come first for that reason, and U5
 * proves them again at corpus scale.
 */

const spec: StatementSpec = {
  name: "mvp:example",
  rules: [
    {
      field: "mode",
      type: "value",
      optional: true,
      enum: ["sse", "stream"],
      route: { kind: "input", name: "mode" },
    },
    { field: "free", type: "value", optional: true, route: { kind: "input", name: "free" } },
  ],
};

/** The single `input[]` entry for `mode`. */
function modeInput(authored: Authored): Record<string, unknown> {
  const encoded = encodeFromSpec(spec, authored);
  return encoded.input!.find((i) => (i as { name: string }).name === "mode") as Record<string, unknown>;
}

describe("enum guard — values it must accept", () => {
  it("accepts a legal bare literal", () => {
    expect(modeInput({ mode: "stream" })).toEqual({
      name: "mode",
      tag: "const",
      value: "stream",
      filters: [],
    });
  });

  it("accepts the legal explicit Value spelling", () => {
    expect(() => modeInput({ mode: c.text("sse") })).not.toThrow();
  });

  it("encodes the literal and the c.text spellings to identical bytes", () => {
    expect(modeInput({ mode: "sse" })).toEqual(modeInput({ mode: c.text("sse") }));
  });

  it("accepts an input binding — resolved at runtime, unknowable here", () => {
    expect(modeInput({ mode: inp("connection_mode") })).toMatchObject({
      tag: "input",
      value: "connection_mode",
    });
  });

  it("accepts a stack-variable reference", () => {
    expect(() => modeInput({ mode: ref("cfg.mode") })).not.toThrow();
  });

  it("accepts an env/setting-tagged value", () => {
    expect(() => modeInput({ mode: { value: "MCP_MODE", tag: "setting", filters: [] } })).not.toThrow();
  });

  it("accepts a FILTERED constant, even one whose base value is out of the set", () => {
    // A filter can rewrite the value before the engine reads it, so the base
    // literal proves nothing.
    const filtered = withFilters(c.text("STREAM"), [filter("to_lower")]);
    expect(() => modeInput({ mode: filtered })).not.toThrow();
  });

  it("accepts the empty value — the editor's unconfigured box", () => {
    // This is the round-trip guarantee: codegen emits this for a field the
    // editor left unset, and that emitted source must re-encode. For a text
    // field the blank form IS `c.text("")` (c.blank covers the other constant
    // tags), so this is the complete case.
    expect(() => modeInput({ mode: c.text("") })).not.toThrow();
  });

  it("accepts an expression-tagged constant, whose source text is not its value", () => {
    expect(() => modeInput({ mode: { value: '"st"|"ream"', tag: "const:expr", filters: [] } })).not.toThrow();
  });

  it("leaves an unconstrained field on the same statement unchecked", () => {
    expect(() => encodeFromSpec(spec, { free: c.text("anything at all") })).not.toThrow();
  });

  it("still omits the field entirely when it is not authored", () => {
    const encoded = encodeFromSpec(spec, {});
    expect(encoded.input).toEqual([]);
  });
});

describe("enum guard — values it must reject", () => {
  it("rejects a wrong bare literal", () => {
    expect(() => modeInput({ mode: "streaming" })).toThrow(
      /field "mode" accepts only "sse" \| "stream" — got "streaming"/,
    );
  });

  it("rejects a wrong constant Value the same way", () => {
    expect(() => modeInput({ mode: c.text("streaming") })).toThrow(/got "streaming"/);
  });

  it("names the statement, so the error is actionable in a long stack", () => {
    expect(() => modeInput({ mode: "nope" })).toThrow(/Statement "mvp:example"/);
  });

  it("points at the dynamic escape hatch rather than just refusing", () => {
    expect(() => modeInput({ mode: "nope" })).toThrow(/dynamic value/);
  });

  it("is case-exact — the engine's set is not case-folded", () => {
    expect(() => modeInput({ mode: "SSE" })).toThrow(/got "SSE"/);
  });

  it("rejects a value that merely contains a legal one", () => {
    expect(() => modeInput({ mode: "sse-v2" })).toThrow(/got "sse-v2"/);
  });
});

describe("enum guard — on the real catalog", () => {
  it("guards the MCP connection_type that motivated this", () => {
    const run = getStatementFactory("mvp:mcp_call_tool");
    expect(() => run({ connection_type: c.text("streaming") })).toThrow(
      /accepts only "sse" \| "stream"/,
    );
    expect(() => run({ connection_type: "stream" })).not.toThrow();
  });

  it("accepts a value with a space verbatim", () => {
    const query = getStatementFactory("mvp:elasticsearch_query");
    expect(() => query({ auth_type: "API Key" })).not.toThrow();
    expect(() => query({ auth_type: "APIKey" })).toThrow(/got "APIKey"/);
  });

  it("now enforces the HTTP verb on the hand-authored api.request wrapper", () => {
    // The wrapper coerces its literal to a Value and delegates to the generated
    // factory, so the guard reaches it — `HttpMethod` was suggestion-only before.
    const request = getStatementFactory("mvp:api_request");
    expect(() => request({ url: c.text("https://x.test"), method: c.text("PATCH") })).not.toThrow();
    expect(() => request({ url: c.text("https://x.test"), method: c.text("PATCHY") })).toThrow(
      /accepts only .*"PATCH"/,
    );
  });

  it("leaves mcp `tool` free — it is stored as tool_name and is not constrained", () => {
    const run = getStatementFactory("mvp:mcp_call_tool");
    expect(() => run({ tool: c.text("literally-any-tool-name") })).not.toThrow();
  });

  it("keeps every constrained field's own default authorable", () => {
    // A field whose schema default is a legal member must accept that member —
    // otherwise the documented default would be unauthorable.
    const encoded = encodeStatement(
      getStatementFactory("mvp:mcp_call_tool")({ connection_type: "sse" }),
    );
    expect(encoded.input).toContainEqual(
      expect.objectContaining({ name: "connection_type", value: "sse" }),
    );
  });
});
