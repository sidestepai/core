/**
 * U3 — value decoder.
 *
 * The oracle here is not "the source looks right", it is "the source *is* right":
 * every case prints the decoded expression and then evaluates it against the real
 * SDK constructors, asserting the re-encoded `{value, tag, filters}` is identical
 * to what went in. Readability can regress silently; exactness cannot.
 */
import { describe, it, expect } from "vitest";
import { TAGS } from "../../src/types/xdo.js";
import type { TaggedValue } from "../../src/types/xdo.js";
import { c, col, auth, env, filter, inp, out, ref, setting, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { rawValue } from "../../src/values/raw-value.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { decodeValue } from "../../src/codegen/value.js";
import { severityOf } from "../../src/codegen/report.js";
import { normalize } from "../../src/validate/normalize.js";

/** Decode a stored value to source text, keeping the context for import/report checks. */
function decodeToSource(v: TaggedValue, ctx = new DecodeContext()): { source: string; ctx: DecodeContext } {
  return { source: printExpr(decodeValue(ctx, v)), ctx };
}

/** Evaluate emitted source against the real SDK surface — the re-encode step. */
function evaluate(source: string): TaggedValue {
  const fn = new Function(
    "c",
    "ref",
    "inp",
    "col",
    "auth",
    "env",
    "setting",
    "out",
    "withFilters",
    "fl",
    "rawValue",
    `return (${source});`,
  );
  return fn(c, ref, inp, col, auth, env, setting, out, withFilters, fl, rawValue) as TaggedValue;
}

/**
 * Decode → print → evaluate → compare. Returns the emitted source for inspection.
 *
 * Compared under `normalize` — the round-trip contract's own comparator, and the
 * same one the decoder proves each candidate against. Byte equality would be a
 * stricter claim than the SDK makes anywhere else, and it is not one a real
 * workspace can satisfy: an older-vintage value stores a numeric `value` or a
 * filter without `disabled`, and the SDK canonicalizes both forward on re-export.
 */
function roundTrip(v: TaggedValue, ctx = new DecodeContext()): string {
  const { source } = decodeToSource(v, ctx);
  const reencoded = evaluate(source);
  expect(normalize({ ...reencoded }), `source: ${source}`).toEqual(normalize({ ...v }));
  return source;
}

/** One representative stored value per tag in the catalog. */
const PER_TAG: Record<string, TaggedValue> = {
  const: { value: "hello", tag: "const", filters: [] },
  "const:int": { value: "42", tag: "const:int", filters: [] },
  "const:decimal": { value: "1.5", tag: "const:decimal", filters: [] },
  "const:bool": { value: "false", tag: "const:bool", filters: [] },
  "const:array": { value: "[1,2,3]", tag: "const:array", filters: [] },
  "const:obj": { value: '{"a":1}', tag: "const:obj", filters: [] },
  "const:null": { value: "null", tag: "const:null", filters: [] },
  "const:epochms": { value: "now", tag: "const:epochms", filters: [] },
  "const:expr": { value: '{"op":"+","l":1,"r":2}', tag: "const:expr", filters: [] },
  "const:expr2": { value: "1 + 2", tag: "const:expr2", filters: [] },
  var: { value: "user", tag: "var", filters: [] },
  input: { value: "email", tag: "input", filters: [] },
  auth: { value: "id", tag: "auth", filters: [] },
  env: { value: "STRIPE_KEY", tag: "env", filters: [] },
  setting: { value: "$remote_ip", tag: "setting", filters: [] },
  col: { value: "created_at", tag: "col", filters: [] },
  output: { value: "id", tag: "output", filters: [] },
  response: { value: "body", tag: "response", filters: [] },
  trycatch: { value: "error", tag: "trycatch", filters: [] },
  toolset: { value: "tools", tag: "toolset", filters: [] },
};

describe("decodeValue — tag coverage", () => {
  // Table-driven over the catalog itself, so a tag added to TAGS without a
  // decoder branch fails here instead of silently degrading on a real workspace.
  it.each([...TAGS])("re-encodes tag %s identically", (tag) => {
    const stored = PER_TAG[tag];
    expect(stored, `no representative value for tag "${tag}"`).toBeDefined();
    roundTrip(stored!);
  });

  it("decodes the constant constructors to their c.* surface", () => {
    expect(roundTrip(PER_TAG["const"]!)).toBe('c.text("hello")');
    expect(roundTrip(PER_TAG["const:int"]!)).toBe("c.int(42)");
    expect(roundTrip(PER_TAG["const:decimal"]!)).toBe("c.decimal(1.5)");
    expect(roundTrip(PER_TAG["const:bool"]!)).toBe("c.bool(false)");
    expect(roundTrip(PER_TAG["const:null"]!)).toBe("c.null()");
    expect(roundTrip(PER_TAG["const:array"]!)).toBe("c.array([\n  1,\n  2,\n  3,\n])");
  });

  it("decodes the reference constructors to their surface", () => {
    expect(roundTrip(PER_TAG["var"]!)).toBe('ref("user")');
    expect(roundTrip(PER_TAG["input"]!)).toBe('inp("email")');
    expect(roundTrip(PER_TAG["auth"]!)).toBe('auth("id")');
    expect(roundTrip(PER_TAG["col"]!)).toBe('col("created_at")');
    expect(roundTrip(PER_TAG["output"]!)).toBe('out("id")');
  });

  it("decodes a dotted var path to the path-form ref, not a literal string", () => {
    expect(roundTrip({ value: "$var.a.b.c", tag: "var", filters: [] })).toBe('ref("$var.a.b.c")');
    expect(roundTrip({ value: "owner.user_id", tag: "var", filters: [] })).toBe('ref("owner.user_id")');
  });

  it("routes a plain-named setting to env() and a $-prefixed one to setting()", () => {
    expect(roundTrip({ value: "STRIPE_KEY", tag: "setting", filters: [] })).toBe('env("STRIPE_KEY")');
    expect(roundTrip({ value: "$remote_ip", tag: "setting", filters: [] })).toBe(
      'setting("$remote_ip")',
    );
  });

  it("does not collapse falsy constants to undefined or elide them", () => {
    roundTrip({ value: "null", tag: "const:null", filters: [] });
    roundTrip({ value: "false", tag: "const:bool", filters: [] });
    roundTrip({ value: "[]", tag: "const:array", filters: [] });
    roundTrip({ value: "{}", tag: "const:obj", filters: [] });
    roundTrip({ value: "", tag: "const", filters: [] });
    roundTrip({ value: "0", tag: "const:int", filters: [] });
  });

  it("falls back to a literal when a numeric constant would not restringify", () => {
    // `c.int(Number("007"))` re-encodes to "7" — a silent value change, so the
    // decoder must not take the readable path here.
    const source = roundTrip({ value: "007", tag: "const:int", filters: [] });
    expect(source).toContain("rawValue");
  });

  it("updates a blank const:obj to c.obj(), and flags it as a change in behavior", () => {
    // The editor stopped writing blank object constants long ago — a new object
    // variable starts at `{}`. Decoding brings them to that current default,
    // which is NOT a no-op: blank evaluates to null, `{}` to an empty object
    // (both live-verified). So it is reported — `modernized`, warning severity:
    // worth a look, not a failure.
    for (const blank of ["", null]) {
      const ctx = new DecodeContext();
      const stored = { value: blank, tag: "const:obj", filters: [] } as unknown as TaggedValue;
      expect(roundTrip(stored, ctx)).toBe("c.obj()");
      expect(ctx.report.entries).toHaveLength(1);
      expect(ctx.report.entries[0]!.category).toBe("modernized");
      expect(ctx.report.entries[0]!.detail).toContain("EVALUATES DIFFERENTLY");
      expect(severityOf("modernized")).toBe("warning");
    }
  });

  it("leaves a populated object constant alone", () => {
    // The modernization is scoped to genuinely blank values; anything with
    // content still decodes normally and reports nothing.
    const ctx = new DecodeContext();
    expect(roundTrip({ value: '{"a":1}', tag: "const:obj", filters: [] }, ctx)).toContain("c.obj(");
    expect(ctx.report.entries).toEqual([]);
  });

  it("falls back to a literal when a JSON constant would not restringify byte-for-byte", () => {
    const source = roundTrip({ value: '{ "a" : 1 }', tag: "const:obj", filters: [] });
    expect(source).toContain("rawValue");
  });
});

describe("decodeValue — filter chains", () => {
  it("re-encodes a 3-filter chain with its filters in the original order", () => {
    const stored = withFilters(c.text(" Hi "), fl.trim(), fl.lower(), fl.concat(c.text("!")));
    const source = roundTrip(stored);
    expect(source.indexOf("fl.trim")).toBeLessThan(source.indexOf("fl.lower"));
    expect(source.indexOf("fl.lower")).toBeLessThan(source.indexOf("fl.concat"));
  });

  it("decodes filter arguments that are themselves tagged values, recursively", () => {
    roundTrip(withFilters(ref("total"), fl.add(withFilters(inp("qty"), fl.mul(c.int(2))))));
  });

  it("decodes c.now() back to c.now(), not to a rawValue", () => {
    expect(roundTrip(c.now())).toBe("c.now()");
  });

  it("degrades only the filter for a disabled one, which fl.* cannot express", () => {
    // `filter()` hard-codes `disabled: false`, so this has no `fl.*` form — but
    // `withFilters` takes a stored filter object directly, so the BASE value stays
    // idiomatic and only the filter rides through verbatim.
    const stored: TaggedValue = {
      value: "x",
      tag: "const",
      filters: [{ name: "trim", disabled: true, arg: [] }],
    };
    const source = roundTrip(stored);
    expect(source).toContain('c.text("x")');
    expect(source).toContain("withFilters(");
    expect(source).not.toContain("rawValue");
  });

  it("degrades only the filter for one outside the catalog", () => {
    const stored: TaggedValue = {
      value: "x",
      tag: "const",
      filters: [{ name: "some_future_filter", disabled: false, arg: [] }],
    };
    const source = roundTrip(stored);
    expect(source).toContain("some_future_filter");
    expect(source).not.toContain("rawValue");
  });

  it("decodes a chain whose filters were stored without `disabled`", () => {
    // The real-workspace shape: Xano's editor omits `disabled` at its default
    // (`disabled?=false`), while `filter()` always writes it. An absent key IS
    // that default, so the whole chain decodes to `fl.*` calls and re-exports
    // the current form — it does not degrade to a verbatim filter literal, and
    // it certainly does not collapse the value (including a perfectly good
    // `ref()`) to `rawValue`.
    const stored = {
      value: "answers",
      tag: "var",
      filters: [
        { name: "array_shuffle", arg: [] },
        { name: "first", arg: [] },
      ],
    } as unknown as TaggedValue;
    const source = roundTrip(stored);
    expect(source).toBe('withFilters(ref("answers"), fl.array_shuffle(), fl.first())');
  });

  it("still degrades a filter the engine stored as disabled", () => {
    // `disabled: true` is a real, authored state with no `fl.*` form — the
    // tolerance above is for an ABSENT key, not for a truthy one.
    const stored = {
      value: "answers",
      tag: "var",
      filters: [{ name: "first", disabled: true, arg: [] }],
    } as unknown as TaggedValue;
    const { source } = decodeToSource(stored);
    expect(source).toContain("disabled: true");
    expect(source).not.toContain("fl.first()");
  });
});

describe("decodeValue — regex values (issue #128 guard)", () => {
  it("decodes a delimiter-wrapped pattern back to c.regex, not a bare c.text", () => {
    const stored = withFilters(c.regex(/^[^@\s]+@[^@\s]+$/i), fl.regex_test(inp("email")));
    const source = roundTrip(stored);
    expect(source).toContain("c.regex(");
    expect(source).not.toContain("c.text(");
  });

  it("preserves an interior escaped slash through the c.regex round trip", () => {
    roundTrip(withFilters(c.regex("a/b"), fl.regex_match(ref("s"))));
  });

  it("does not throw on a bare, undelimited pattern piped to a regex filter", () => {
    // `withFilters` rejects this shape at encode time, so the readable path is
    // unavailable — but a bundle can legitimately contain it, and pulling it must
    // not be a hard error.
    const stored: TaggedValue = {
      value: "^abc$",
      tag: "const",
      filters: [{ name: "regex_test", disabled: false, arg: [{ value: "x", tag: "const", filters: [] }] }],
    };
    const source = roundTrip(stored);
    expect(source).toContain("rawValue");
  });

  it("leaves a non-slash-delimited pattern to the literal fallback", () => {
    const stored: TaggedValue = {
      value: "~abc~i",
      tag: "const",
      filters: [{ name: "regex_match", disabled: false, arg: [] }],
    };
    expect(roundTrip(stored)).toContain("rawValue");
  });

  it("decodes a regex-shaped const with no regex filter as plain text", () => {
    expect(roundTrip({ value: "/not/a/pattern/", tag: "const", filters: [] })).toContain("c.text(");
  });
});

describe("decodeValue — reporting and imports", () => {
  it("reports exactly one entry for a value it could not express", () => {
    // `response` is an engine-side tag with no authoring constructor — the
    // remaining shape of "genuinely not expressible". (The expression tags used
    // to stand in here; they decode through c.expression now.)
    const ctx = new DecodeContext();
    roundTrip({ value: "body", tag: "response", filters: [] }, ctx);
    expect(ctx.report.entries).toHaveLength(1);
    expect(ctx.report.entries[0]!.category).toBe("value-fallback");
    expect(ctx.report.entries[0]!.detail).toContain("response");
  });

  it("reports nothing for values it decodes cleanly", () => {
    const ctx = new DecodeContext();
    roundTrip(withFilters(ref("a"), fl.trim()), ctx);
    roundTrip(c.int(1), ctx);
    expect(ctx.report.entries).toEqual([]);
  });

  it("records the imports each decoded expression needs", () => {
    const ctx = new DecodeContext();
    ctx.beginFile();
    decodeValue(ctx, withFilters(ref("a"), fl.trim()));
    decodeValue(ctx, c.int(1));
    expect(ctx.imports.toStatements()).toEqual([
      { kind: "import", module: "@sidestep/core", symbols: ["c", "fl", "ref", "withFilters"] },
    ]);
  });

  it("imports rawValue from the codegen entry, not from the authoring entry", () => {
    const ctx = new DecodeContext();
    ctx.beginFile();
    decodeValue(ctx, { value: "body", tag: "response", filters: [] });
    expect(ctx.imports.toStatements()).toEqual([
      { kind: "import", module: "@sidestep/core/codegen", symbols: ["rawValue"] },
    ]);
  });
});

describe("rawValue", () => {
  it("returns the exact stored shape, filling an absent filter list", () => {
    expect({ ...rawValue({ value: "x", tag: "const:expr" }) }).toEqual({
      value: "x",
      tag: "const:expr",
      filters: [],
    });
  });

  it("passes filters through untouched", () => {
    const filters = [filter("trim")];
    expect(rawValue({ value: "x", tag: "const", filters }).filters).toEqual(filters);
  });
});
