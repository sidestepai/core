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
import { c, col, auth, caught, env, filter, inp, out, ref, setting, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { rawValue } from "../../src/values/raw-value.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { decodeValue } from "../../src/codegen/value.js";
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
    "caught",
    "env",
    "setting",
    "out",
    "withFilters",
    "fl",
    "rawValue",
    `return (${source});`,
  );
  return fn(c, ref, inp, col, auth, caught, env, setting, out, withFilters, fl, rawValue) as TaggedValue;
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

  it("recovers a blank const:obj EXACTLY, as c.obj(null), with nothing to report", () => {
    // A blank object constant and `{}` are not one value. The engine JSON-decodes
    // the stored string, so a blank yields null where `{}` yields an empty object
    // (both live-verified). Both blank spellings — `""` and `null` — do decode to
    // null, so they ARE one value, and `c.obj(null)` writes the dominant one.
    //
    // This used to come back as `c.obj()` behind a `modernized` warning, which
    // re-pointed 113 statements in the survey corpus at `{}` on the next deploy.
    // An exact spelling needs no warning at all.
    for (const blank of ["", null]) {
      const ctx = new DecodeContext();
      const stored = { value: blank, tag: "const:obj", filters: [] } as unknown as TaggedValue;
      expect(roundTrip(stored, ctx)).toBe("c.obj(null)");
      expect(ctx.report.entries).toEqual([]);
    }
  });

  it("keeps `c.obj()` and `c.obj(null)` as DISTINCT values", () => {
    // The load-bearing negative. If these ever collapse into one spelling, the
    // blank form silently becomes an empty object again — which is exactly the
    // regression this pair exists to catch.
    expect(c.obj()).toEqual({ value: "{}", tag: "const:obj", filters: [] });
    expect(c.obj(null)).toEqual({ value: "", tag: "const:obj", filters: [] });
    // …and `normalize` must NOT equate them: it canonicalizes the two BLANK
    // spellings together, and nothing else.
    expect(normalize(c.obj(null))).toEqual(
      normalize({ value: null, tag: "const:obj", filters: [] }),
    );
    expect(normalize(c.obj(null))).not.toEqual(normalize(c.obj()));
  });

  it("decodes a populated object constant — `{}` plus `set` filters — back to c.obj({…})", () => {
    // The form `c.obj({…})` writes and the editor stores (issue #248): the
    // record comes back as a record, not as a withFilters/fl.set chain.
    const ctx = new DecodeContext();
    const source = roundTrip(c.obj({ a: 1, b: "x", c: { d: true }, e: [1, 2] }), ctx);
    expect(source.replace(/\s+/g, " ")).toBe(
      'c.obj({ a: 1, b: "x", c: { d: true, }, e: [ 1, 2, ], })',
    );
    expect(ctx.report.entries).toEqual([]);
  });

  it("decodes a bracket-escaped set path back to the literal key it stands for", () => {
    expect(roundTrip(c.obj({ "a.b": 1 })).replace(/\s+/g, " ")).toBe('c.obj({ "a.b": 1, })');
    // Every escaped shape the encoder can write is its own inverse — a key that
    // came back wrong would fail the byte check and fall out to a filter chain,
    // so assert the readable form itself.
    for (const key of ["0", "1a", 'q"x', "a\\", 'a\\"b', "items[0]", "sp ace"]) {
      expect(roundTrip(c.obj({ [key]: 1 }))).toBe(`c.obj({\n  ${JSON.stringify(key)}: 1,\n})`);
    }
  });

  it("keeps a stored `__proto__` set path as a filter chain, not an object key", () => {
    // In emitted source both `{ __proto__: … }` and `{ "__proto__": … }` set the
    // PROTOTYPE, so a record spelling would re-encode to an object missing the
    // key. `roundTrip` re-evaluates the source, so it is the assertion here.
    const source = roundTrip(withFilters(c.obj(), fl.set(c.text("__proto__"), c.text("x"))));
    expect(source).toContain("withFilters(");
    // It appears as `set` DATA, never as a key of the emitted record.
    expect(source).toContain('c.text("__proto__")');
    expect(source).not.toMatch(/__proto__"?\s*:/);
  });

  it("keeps a set chain whose member is not a plain constant as a filter chain", () => {
    // A blank `const:int` member reads as 0 through `Number("")`, so it must not
    // be flattened into a literal — the byte check is what stops it.
    const source = roundTrip(withFilters(c.obj(), fl.set(c.text("n"), c.blank("const:int"))));
    expect(source).toContain("withFilters(");
  });

  it("keeps a set chain that is not a plain-JSON record as a filter chain", () => {
    // A `set` carrying a live reference is not something `c.obj` can spell, so
    // it stays the generic chain rather than being flattened into a literal.
    const source = roundTrip(withFilters(c.obj(), fl.set(c.text("a"), ref("x"))));
    expect(source).toContain("withFilters(");
    expect(source).toContain("fl.set(");
  });

  it("carries a populated JSON object constant verbatim", () => {
    // The legacy stored spelling — a populated JSON *string* — is not what any
    // `c.*` call produces now, so it is emitted verbatim rather than re-pointed
    // at the `{}`-plus-`set` form, which is different bytes (issue #248).
    expect(roundTrip({ value: '{"a":1}', tag: "const:obj", filters: [] })).toContain("rawValue");
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

describe("decodeValue — transform expressions (issue #245 guard)", () => {
  it("decodes an expression the guard accepts through the readable fl.transform form", () => {
    const source = roundTrip(withFilters(c.array([3, 1, 2]), fl.transform('$0|sort|join:","')));
    expect(source).toContain("fl.transform(");
    expect(source).not.toContain("rawValue");
  });

  // `$this` resolves to null on this path and a `return` is JavaScript, so
  // AUTHORING either is refused — but a real workspace can hold one (the
  // engine's own filter description teaches `$this`), and pulling that workspace
  // must not be a hard error. `roundTrip` evaluates the emitted source and
  // asserts it re-encodes to the same bytes, so these prove the degraded form is
  // both compilable and exact.
  for (const [what, expression] of [
    ["a `$this` binding", "$this * 2"],
    ["a JavaScript body", "return $0 * 2"],
  ] as const) {
    it(`carries ${what} through the degraded filter form instead of throwing`, () => {
      const stored: TaggedValue = {
        value: "5",
        tag: "const:int",
        filters: [
          { name: "transform", disabled: false, arg: [{ value: expression, tag: "const", filters: [] }] },
        ],
      };
      const source = roundTrip(stored);
      // The readable `fl.transform(...)` form would throw when evaluated, so the
      // decoder must not reach for it.
      expect(source).not.toContain("fl.transform(");
      expect(source).toContain('name: "transform"');
    });
  }
});

describe("decodeValue — fsort comparator (issue #198 guard)", () => {
  it("carries a stored non-member comparator through the degraded filter form", () => {
    // The authoring surface refuses `fl.fsort(path, c.text("decimal"))` because
    // the engine silently sorts as text. A real workspace can still hold one, so
    // pulling it must not be a hard error — and must re-encode byte-identically.
    // This is the evidence that refusing at author time costs no round trip.
    const stored: TaggedValue = {
      value: "[]",
      tag: "const:array",
      filters: [
        {
          name: "fsort",
          disabled: false,
          arg: [
            { value: "score", tag: "const", filters: [] },
            { value: "decimal", tag: "const", filters: [] },
          ],
        },
      ],
    };
    const source = roundTrip(stored);
    expect(source).not.toContain("fl.fsort(");
    expect(source).toContain('name: "fsort"');
  });

  it("still decodes a VALID comparator through the readable fl.fsort form", () => {
    const source = roundTrip(withFilters(c.array([]), fl.fsort(c.text("score"), c.text("number"))));
    expect(source).toContain("fl.fsort(");
    expect(source).not.toContain('name: "fsort"');
  });
});

describe("c.blank — the editor's unconfigured value box", () => {
  // 13 of the 16 `value-fallback` rows in the survey corpus were this: a value
  // cell added in the editor and never filled in. The decode was already exact,
  // but there was no constructor that meant "blank", so it came back as an
  // annotated literal with a warning attached to a state nothing was wrong with.

  it("round-trips every blank const tag through a typed call", () => {
    for (const tag of ["const:int", "const:decimal", "const:array", "const:expr", "const:expr2", "const:bool", "const:null", "const:epochms"] as const) {
      const ctx = new DecodeContext();
      const source = roundTrip({ value: "", tag, filters: [] }, ctx);
      expect(source).toBe(`c.blank("${tag}")`);
      // The whole point: no warning, because nothing went wrong.
      expect(ctx.report.entries).toEqual([]);
    }
  });

  it("is NOT a zero, an empty string, or an empty collection", () => {
    // The load-bearing negative. Canonicalizing a blank into `c.int(0)` would be
    // readable and would silently re-point 13 real values at a different stored
    // value — the engine reads `""` and `"0"` differently.
    expect(c.blank("const:int")).not.toEqual(c.int(0));
    expect(c.blank("const:decimal")).not.toEqual(c.decimal(0));
    expect(c.blank("const:array")).not.toEqual(c.array([]));
    expect(c.blank("const:null")).not.toEqual(c.null());
    expect(c.blank("const:bool")).not.toEqual(c.bool(false));
    // …and each keeps its own tag rather than collapsing to a bare `const`.
    expect(c.blank("const:int")).not.toEqual(c.text(""));
  });

  it("leaves the tags that already have an exact blank form alone", () => {
    // `const` blank is `c.text("")` and `const:obj` blank is `c.obj(null)`, both
    // of which predate this and both of which are exact. A second spelling for
    // the same bytes is how two constructors start disagreeing.
    expect(roundTrip({ value: "", tag: "const", filters: [] })).toBe('c.text("")');
    expect(roundTrip({ value: "", tag: "const:obj", filters: [] })).toBe("c.obj(null)");
  });

  it("still falls back for a blank tag that is a reference, not a value box", () => {
    // A blank `var`/`input` is an unbound REFERENCE, which is a different defect
    // with a different fix. `c.blank` is deliberately not a way to spell it.
    const ctx = new DecodeContext();
    roundTrip({ value: "", tag: "response", filters: [] }, ctx);
    expect(ctx.report.entries.map((e) => e.category)).toEqual(["value-fallback"]);
  });
});

describe("c.decimal — stored precision", () => {
  it("preserves trailing zeros when given a string", () => {
    // A stored `"10.00"` is one row in the survey corpus and no number literal
    // reproduces it: `c.decimal(10)` writes `"10"`. The engine stores decimals as
    // strings, so passing the string through is exact rather than a workaround.
    expect(roundTrip({ value: "10.00", tag: "const:decimal", filters: [] })).toBe(
      'c.decimal("10.00")',
    );
    expect(roundTrip({ value: "0.500", tag: "const:decimal", filters: [] })).toBe(
      'c.decimal("0.500")',
    );
  });

  it("still emits the number form when a number reproduces the bytes", () => {
    // The paired negative: the readable spelling stays the default, and the
    // string form is reserved for what it cannot express.
    expect(roundTrip({ value: "1.5", tag: "const:decimal", filters: [] })).toBe("c.decimal(1.5)");
    expect(roundTrip({ value: "10", tag: "const:decimal", filters: [] })).toBe("c.decimal(10)");
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

  it("calls a blank REFERENCE an unbound binding, not an empty value box", () => {
    // The two used to share one sentence, because a blank constant was also a
    // fallback. It is `c.blank(tag)` now, so the only blanks that reach here are
    // references naming nothing — where "the editor's unconfigured value box"
    // would be describing the wrong defect and pointing at the wrong fix.
    const ctx = new DecodeContext();
    roundTrip({ value: "", tag: "response", filters: [] }, ctx);
    expect(ctx.report.entries).toHaveLength(1);
    const detail = String(ctx.report.entries[0]!.detail);
    expect(detail).toContain("a blank response");
    expect(detail).toContain("names nothing");
    expect(detail).not.toContain("value box");
    expect(detail).not.toContain("no idiomatic form");
  });

  it("quotes the value a constructor cannot reproduce exactly", () => {
    // The decimal that used to prove this decodes now, so the case is carried by
    // a tag with no constructor at all — the shape the message still has to fit.
    const ctx = new DecodeContext();
    roundTrip({ value: "body.id", tag: "response", filters: [] }, ctx);
    expect(String(ctx.report.entries[0]!.detail)).toContain('"body.id"');
  });

  it("still calls an unrecognized tag unknown", () => {
    const ctx = new DecodeContext();
    roundTrip({ value: "x", tag: "const:nope", filters: [] } as never, ctx);
    expect(String(ctx.report.entries[0]!.detail)).toContain("unknown tag const:nope");
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
