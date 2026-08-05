/**
 * U6 — specials statement decoders (control flow, loops, vars, calls) and the
 * boolean-expression inverse they share.
 *
 * Characterization-first, as the plan asks: each case starts from what the real
 * encoder persists, not from a description of it. The encoders carry non-obvious
 * stored details — `break` omitted entirely when unset, an `or` flag that lives
 * on the sibling rather than the container — and every assertion here goes
 * through encode → decode → evaluate → re-encode so a subtly wrong inverse fails
 * rather than producing plausible-looking source.
 */
import { describe, it, expect } from "vitest";
import { s } from "../../src/statements/s.js";
import { and, cmp, expr, mixed, or } from "../../src/statements/expression.js";
import { encodeStatement } from "../../src/statements/statement.js";
import type { Statement } from "../../src/statements/statement.js";
import type { StackItemXdo } from "../../src/types/xdo.js";
import { normalize } from "../../src/validate/normalize.js";
import { c, col, auth, env, inp, out, ref, setting, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { rawValue } from "../../src/values/raw-value.js";
import { raw } from "../../src/statements/special/raw.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeStatement } from "../../src/codegen/statement.js";

const EMPTY_REFS = RefIndex.fromPayload({}, new DecodeContext());

const SURFACE = {
  s, c, ref, inp, col, auth, env, setting, out,
  withFilters, fl, rawValue, raw, expr, cmp, and, or, mixed,
};

/**
 * Evaluate emitted statement source against the real authoring surface.
 *
 * `symbols` stands in for what a generated file would import from its siblings —
 * a cross-object reference decodes to a bare symbol, and only the surrounding
 * project supplies it.
 */
function evaluate(source: string, symbols: Record<string, unknown> = {}): Statement {
  const scope = { ...SURFACE, ...symbols };
  const names = Object.keys(scope);
  const fn = new Function(...names, `return (${source});`);
  return fn(...names.map((name) => (scope as Record<string, unknown>)[name])) as Statement;
}

/**
 * Encode a statement, decode it back to source, evaluate, re-encode, and assert
 * the two stored forms match. Returns the emitted source for inspection.
 *
 * `symbols` are the sibling bindings a generated file would import; supplying
 * them is also what makes the emitted reference a symbol rather than a literal.
 */
function roundTrip(
  statement: Statement,
  refs = EMPTY_REFS,
  symbols: Record<string, unknown> = {},
): string {
  const stored = encodeStatement(statement);
  const ctx = new DecodeContext();
  const resolve = Object.keys(symbols).length > 0 ? { symbolFor: (t: { name: string }) => t.name } : {};
  const source = printExpr(decodeStatement(ctx, refs, stored, resolve));
  expect(normalize(encodeStatement(evaluate(source, symbols))), `source: ${source}`).toEqual(
    normalize(stored),
  );
  return source;
}

/** Sibling bindings for the call-family tests, by the name the decoder emits. */
const CALL_SYMBOLS = {
  helper: { name: "helper", guid: "aaaa000000000000000000000000aaaa" },
  get_user: { name: "get_user", guid: "bbbb000000000000000000000000bbbb" },
  nightly: { name: "nightly", guid: "cccc000000000000000000000000cccc" },
  rate_limit: { name: "rate_limit", guid: "dddd000000000000000000000000dddd" },
};

describe("variables", () => {
  it("round-trips set_var — the single most common statement in a workspace", () => {
    expect(roundTrip(s.set_var("total", c.int(0)))).toBe('s.set_var("total", c.int(0))');
  });

  it("round-trips set_var carrying a filtered value", () => {
    roundTrip(s.set_var("name", withFilters(inp("raw"), fl.trim(), fl.lower())));
  });

  it("round-trips update_var, which names its target in context", () => {
    expect(roundTrip(s.update_var("total", c.int(1)))).toBe('s.update_var("total", c.int(1))');
  });

  // A `set_var` whose context is EMPTY. Not a shape the SDK writes — these bytes
  // are copied from a real stored statement — but the engine's optional-schema
  // pass fills `tag` with `const`, `filters` with `[]`, and `value` with the text
  // type's `""`, so it is the blank const spelled a second way. 18 statements in
  // the survey corpus store it against 101 that store the members explicitly.
  const STORED_EMPTY_SET_VAR = {
    as: "x2",
    name: "mvp:set_var",
    addon: [],
    input: [],
    output: { items: [], filters: [], customize: false },
    context: {},
    disabled: false,
    description: "",
    settings_registry: null,
  } as unknown as StackItemXdo;

  it("reads an empty set_var context as the blank const rather than falling back to raw()", () => {
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, EMPTY_REFS, STORED_EMPTY_SET_VAR, {}));
    expect(source).toBe('s.set_var("x2", c.text(""))');
    // The recovered statement must compare equal to the bytes it came from —
    // the empty and explicit spellings are one statement under the comparator.
    expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(STORED_EMPTY_SET_VAR));
  });

  it("recovers an empty update_var context, taking BOTH members from the fill", () => {
    // `update_var` carries its target variable inside `context`, so an empty one
    // has to take the name and the value from the same fill or neither. Every
    // member is a scalar (`{name, value, tag?=const, filters[]}`), so the
    // engine's optional pass materializes all of them — and the editor saves
    // this state: its context form declares no required validator.
    const ctx = new DecodeContext();
    // The real stored shape, from the workspace that carries one: `as` is blank
    // (an update names its target in `context`, not on the envelope).
    const stored = {
      ...STORED_EMPTY_SET_VAR,
      as: "",
      name: "mvp:update_var",
    } as unknown as StackItemXdo;
    const source = printExpr(decodeStatement(ctx, EMPTY_REFS, stored, {}));
    expect(source).toBe('s.update_var("", c.text(""))');
    expect(ctx.report.entries).toEqual([]);
    // Byte-exact against the sparse spelling it came from, which is the only
    // reason recovering it is safe.
    expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
  });
});

describe("conditionals", () => {
  it("round-trips a bare if/then", () => {
    const source = roundTrip(
      s.conditional({ when: expr(ref("n"), ">", c.int(0)), then: [s.set_var("big", c.bool(true))] }),
    );
    expect(source).toContain("s.conditional(");
    expect(source).toContain("expr(");
  });

  it("preserves elif branch order and the else block", () => {
    const source = roundTrip(
      s.conditional({
        when: expr(ref("n"), ">", c.int(10)),
        then: [s.set_var("size", c.text("big"))],
        elif: [
          { when: expr(ref("n"), ">", c.int(5)), then: [s.set_var("size", c.text("medium"))] },
          { when: expr(ref("n"), ">", c.int(1)), then: [s.set_var("size", c.text("small"))] },
        ],
        else: [s.set_var("size", c.text("tiny"))],
      }),
    );
    expect(source.indexOf("medium")).toBeLessThan(source.indexOf("small"));
    expect(source.indexOf("small")).toBeLessThan(source.indexOf("tiny"));
  });

  it("omits an empty else rather than emitting an empty block", () => {
    expect(
      roundTrip(s.conditional({ when: expr(ref("a"), "=", c.int(1)), then: [] })),
    ).not.toContain("else");
  });
});

describe("expression algebra", () => {
  it("decodes a narrow comparison to expr() and a wide one to cmp()", () => {
    expect(roundTrip(s.while({ when: expr(ref("i"), "<", c.int(3)), body: [] }))).toContain("expr(");
    expect(roundTrip(s.while({ when: cmp(ref("name"), "like", c.text("%x%")), body: [] }))).toContain(
      "cmp(",
    );
  });

  it("preserves a nested and/or tree's structure", () => {
    const source = roundTrip(
      s.while({
        when: and(
          expr(ref("a"), "=", c.int(1)),
          or(expr(ref("b"), "=", c.int(2)), expr(ref("c"), "=", c.int(3))),
        ),
        body: [],
      }),
    );
    expect(source).toContain("and(");
    expect(source).toContain("or(");
  });

  // R-D — a root `or(...)` joins the ROOT siblings rather than wrapping them.
  // Before this, the flat spelling (which is the only one real workspaces store)
  // had no authored form, so every statement carrying one fell back to `raw()`.
  describe("a flat top-level OR", () => {
    it("round-trips as or(...), not as an ANDed array", () => {
      // The array form means ANDed, so reading an ORed container back as an array
      // would quietly invert what the statement matches.
      const source = roundTrip(
        s.conditional({
          when: or(expr(ref("a"), "=", c.int(1)), expr(ref("b"), "=", c.int(2))),
          then: [s.set_var("hit", c.bool(true))],
        }),
      );
      expect(source).toContain("or(");
      expect(source).not.toContain("raw(");
    });

    it("recovers a MIXED container as mixed(...), and says it is ambiguous", () => {
      // `a AND b OR c` is a state the editor allows — every row after the first
      // carries its own join — so it has to round-trip. `and(...)`/`or(...)`
      // would re-encode every sibling the same way and change what the statement
      // matches; `mixed(...)` carries each join term by term.
      const stored = structuredClone(
        encodeStatement(
          s.conditional({
            when: [
              expr(ref("a"), "=", c.int(1)),
              expr(ref("b"), "=", c.int(2)),
              expr(ref("c"), "=", c.int(3)),
            ],
            then: [s.set_var("hit", c.bool(true))],
          }),
        ),
      ) as StackItemXdo;
      const nodes = (stored.context as { expr: { expression: Array<{ or: boolean }> } }).expr
        .expression;
      nodes[2]!.or = true; // a AND b OR c

      const ctx = new DecodeContext();
      const source = printExpr(decodeStatement(ctx, EMPTY_REFS, stored));
      expect(source).toContain("mixed(");
      expect(source).not.toContain("raw(");
      // Byte-exact, which is the only reason emitting it at all is safe.
      expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
      // …and REPORTED, because the stored form does not say which grouping was
      // meant and the two contexts it can appear in read it differently.
      const entry = ctx.report.entries.find((e) => e.category === "ambiguous-condition");
      expect(entry?.detail).toContain("mixes AND and OR");
      expect(entry?.detail).toContain("left to right");
    });

    it("declines a comparison whose operator no authoring form accepts", () => {
      // A filter row added and never configured stores `op: ""`. Emitting
      // `cmp(…, "", …)` for it produced a tree that THREW the moment it was
      // loaded, so one unconfigured row failed a whole workspace's verification.
      // Declining hands the caller its own exact fallback instead.
      const stored = structuredClone(
        encodeStatement(
          s.conditional({
            when: expr(ref("a"), "=", c.int(1)),
            then: [s.set_var("hit", c.bool(true))],
          }),
        ),
      ) as StackItemXdo;
      const nodes = (stored.context as { expr: { expression: Array<{ statement: { op: string } }> } })
        .expr.expression;
      nodes[0]!.statement.op = "";

      const ctx = new DecodeContext();
      const source = printExpr(decodeStatement(ctx, EMPTY_REFS, stored));
      expect(source).toContain("raw(");
      expect(source).not.toContain('cmp(');
      // Still byte-exact — `raw()` is what fidelity looks like here.
      expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
    });

    it("declines an `or` flag on the FIRST sibling, which joins to nothing", () => {
      const stored = structuredClone(
        encodeStatement(
          s.conditional({
            when: or(expr(ref("a"), "=", c.int(1)), expr(ref("b"), "=", c.int(2))),
            then: [s.set_var("hit", c.bool(true))],
          }),
        ),
      ) as StackItemXdo;
      const nodes = (stored.context as { expr: { expression: Array<{ or: boolean }> } }).expr
        .expression;
      nodes[0]!.or = true;

      const source = printExpr(decodeStatement(new DecodeContext(), EMPTY_REFS, stored));
      expect(source).toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
    });
  });

  it("round-trips a comparison carrying ignoreEmpty, which expr() cannot express", () => {
    const source = roundTrip(
      s.while({ when: cmp(ref("q"), "like", inp("term"), { ignoreEmpty: true }), body: [] }),
    );
    expect(source).toContain("ignoreEmpty");
    expect(source).toContain("cmp(");
  });

  it("round-trips a filtered operand inline in a condition", () => {
    roundTrip(
      s.while({ when: expr(withFilters(ref("s"), fl.lower()), "=", c.text("x")), body: [] }),
    );
  });
});

describe("switch", () => {
  it("preserves case order and the default block", () => {
    const source = roundTrip(
      s.switch({
        on: ref("kind"),
        cases: [
          { when: c.text("a"), body: [s.set_var("r", c.int(1))], break: true },
          { when: c.text("b"), body: [s.set_var("r", c.int(2))] },
        ],
        default: [s.set_var("r", c.int(0))],
      }),
    );
    expect(source.indexOf('c.text("a")')).toBeLessThan(source.indexOf('c.text("b")'));
    expect(source).toContain("default");
  });

  it("carries an explicit break and omits an unset one", () => {
    // `break` is dropped from the stored shape entirely when unset, so its
    // presence — not its value — is what has to survive.
    expect(
      roundTrip(s.switch({ on: ref("k"), cases: [{ when: c.text("a"), body: [], break: false }] })),
    ).toContain("break");
    expect(
      roundTrip(s.switch({ on: ref("k"), cases: [{ when: c.text("a"), body: [] }] })),
    ).not.toContain("break");
  });
});

describe("try/catch and loops", () => {
  it("round-trips all three try_catch blocks", () => {
    const source = roundTrip(
      s.try_catch({
        try: [s.set_var("x", c.int(1))],
        catch: [s.set_var("x", c.int(-1))],
        finally: [s.set_var("done", c.bool(true))],
      }),
    );
    expect(source).toContain("try");
    expect(source).toContain("catch");
    expect(source).toContain("finally");
  });

  // A loop whose iterand went missing on the way out. NOT an engine default —
  // a live engine raises "For Each Loop: missing list argument" and faults on
  // `Undefined array key "cnt"` — so the stored statement THROWS. It is repaired
  // to the empty iterand it lost, which is a no-op instead of a fault, and every
  // site is reported because that changes what the loop does.
  describe("a loop with no iterand", () => {
    function storedLoop(name: string, member: string): StackItemXdo {
      const context: Record<string, unknown> = { as: "row", run: [] };
      // `member` is deliberately NOT set — that is the shape under test.
      void member;
      return { name, context, input: [], disabled: false } as unknown as StackItemXdo;
    }

    for (const [name, member, expected] of [
      ["mvp:foreach", "list", "c.array([])"],
      ["mvp:for", "cnt", "c.int(0)"],
    ] as const) {
      it(`repairs ${name} to the empty ${member} and reports it`, () => {
        const ctx = new DecodeContext();
        const stored = storedLoop(name, member);
        const source = printExpr(decodeStatement(ctx, EMPTY_REFS, stored, {}));

        expect(source).not.toContain("raw(");
        expect(source).toContain(expected);
        expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));

        // Flagged, never silent: turning a runtime fault into a no-op is a
        // behaviour change and has to be visible.
        const modernized = ctx.report.entries.filter((e) => e.category === "modernized");
        expect(modernized).toHaveLength(1);
        expect(modernized[0]!.detail).toContain("EVALUATES DIFFERENTLY");
      });
    }

    it("reports nothing when the iterand IS stored", () => {
      const ctx = new DecodeContext();
      const stored = encodeStatement(
        s.foreach({ as: "row", list: ref("rows"), body: [] }),
      ) as StackItemXdo;
      printExpr(decodeStatement(ctx, EMPTY_REFS, stored, {}));
      expect(ctx.report.entries.filter((e) => e.category === "modernized")).toEqual([]);
    });
  });

  it("round-trips each loop form with its nested body intact", () => {
    expect(roundTrip(s.for({ as: "i", count: c.int(3), body: [s.set_var("x", ref("i"))] }))).toContain(
      "s.for(",
    );
    expect(
      roundTrip(s.foreach({ as: "item", list: ref("items"), body: [s.set_var("x", ref("item"))] })),
    ).toContain("s.foreach(");
    expect(roundTrip(s.while({ when: expr(ref("i"), "<", c.int(3)), body: [] }))).toContain("s.while(");
    expect(roundTrip(s.group([s.set_var("x", c.int(1))]))).toContain("s.group(");
  });

  it("round-trips the nullary loop-control statements", () => {
    roundTrip(s.foreach_break());
    roundTrip(s.foreach_continue());
    roundTrip(s.foreach_remove());
  });
});

describe("nesting and depth", () => {
  it("decodes an unmodelled statement to raw() at the correct depth, keeping the outside readable", () => {
    const unknown = raw({ name: "mvp:some_future_statement", context: { depth: 3 } });
    const source = roundTrip(
      s.conditional({
        when: expr(ref("a"), "=", c.int(1)),
        then: [s.foreach({ as: "i", list: ref("xs"), body: [unknown] })],
      }),
    );
    // The enclosing statements decode; only the unmodelled leaf falls back.
    expect(source).toContain("s.conditional(");
    expect(source).toContain("s.foreach(");
    expect(source).toContain("raw(");
  });

  it("reports the raw fallback at its nested path, not at the top of the stack", () => {
    const ctx = new DecodeContext();
    const stored = encodeStatement(
      s.group([raw({ name: "mvp:unknown_thing", context: {} })]),
    );
    ctx.at("stack[0]", () => decodeStatement(ctx, EMPTY_REFS, stored));
    expect(ctx.report.entries).toHaveLength(1);
    expect(ctx.report.entries[0]!.path).toBe("stack[0].run[0]");
  });
});

describe("call family", () => {
  const REFS = RefIndex.fromPayload(
    {
      function: [{ name: "helper", guid: "aaaa000000000000000000000000aaaa" }],
      query: [{ name: "get_user", guid: "bbbb000000000000000000000000bbbb" }],
      task: [{ name: "nightly", guid: "cccc000000000000000000000000cccc" }],
      middleware: [{ name: "rate_limit", guid: "dddd000000000000000000000000dddd" }],
    },
    new DecodeContext(),
  );

  it("resolves a call target through the ref index to a symbol", () => {
    const source = roundTrip(
      s.function.run({ fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" }, as: "r" }),
      REFS,
      CALL_SYMBOLS,
    );
    expect(source).toContain("s.function.run(");
    expect(source).toContain("helper");
  });

  it("round-trips call input bindings", () => {
    roundTrip(
      s.function.call({
        fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" },
        input: { id: inp("id"), label: c.text("x") },
      }),
      REFS,
      CALL_SYMBOLS,
    );
  });

  it("round-trips api.call's headers and token auth", () => {
    const source = roundTrip(
      s.api.call({
        api: { name: "get_user", guid: "bbbb000000000000000000000000bbbb" },
        headers: c.obj({ "X-Trace": "1" }),
        auth: { token: ref("token"), ignoreExpiration: true },
      }),
      REFS,
      CALL_SYMBOLS,
    );
    expect(source).toContain("headers");
    expect(source).toContain("ignoreExpiration");
  });

  it("round-trips the input-less task.call and the middleware call", () => {
    roundTrip(s.task.call({ task: { name: "nightly", guid: "cccc000000000000000000000000cccc" } }), REFS, CALL_SYMBOLS);
    roundTrip(
      s.middleware.call({
        middleware: { name: "rate_limit", guid: "dddd000000000000000000000000dddd" },
      }),
      REFS,
      CALL_SYMBOLS,
    );
  });

  it("decodes an unbound call target as `fn: null`", () => {
    // A call whose target function was deleted stores a blank `context.function.id`
    // — an unbound reference, not a decode failure. 17 statements across the sweep.
    for (const [statement, expected] of [
      [s.function.run({ fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" } }), "s.function.run("],
    ] as const) {
      const bound = encodeStatement(statement);
      const stored = {
        ...bound,
        context: { ...(bound.context as Record<string, unknown>), function: { id: "" } },
      } as StackItemXdo;
      const source = printExpr(decodeStatement(new DecodeContext(), REFS, stored));
      expect(source).toContain(expected);
      expect(source).toContain("fn: null");
      expect(source).not.toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, CALL_SYMBOLS)))).toEqual(normalize(stored));
    }
  });

  it("does not offer null to a call surface that cannot express it", () => {
    // `callDecoder` is shared, and only the mvp:function surfaces model the unbound
    // state. Everything else must keep declining rather than build a call its
    // factory would throw on — raw() is exact, a thrown factory is just noise.
    const bound = encodeStatement(
      s.task.call({ task: { name: "nightly", guid: "cccc000000000000000000000000cccc" } }),
    );
    const stored = {
      ...bound,
      context: { ...(bound.context as Record<string, unknown>), id: "" },
    } as StackItemXdo;
    const source = printExpr(decodeStatement(new DecodeContext(), REFS, stored));
    expect(source).toContain("raw(");
    expect(source).not.toContain("s.task.call(");
    // `task: null` specifically — the raw blob's own `runtime: null` is not that.
    expect(source).not.toContain("task: null");
    expect(normalize(encodeStatement(evaluate(source, CALL_SYMBOLS)))).toEqual(normalize(stored));
  });

  // Once the plan's headline discrimination case: one stored name, two surfaces.
  // It is one surface now — connected-service functions were never released in
  // Xano, and the key that discriminated them (`context.runtime_mode`) is not a
  // stored key at all, so the branch could only fire on the SDK's own bytes.
  it("routes every mvp:function to the one surface that exists", () => {
    const plain = roundTrip(
      s.function.run({ fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" } }),
      REFS,
      CALL_SYMBOLS,
    );
    expect(plain).toContain("s.function.run(");
    expect(plain).not.toContain("service");
  });

  it("preserves a call whose target is absent from the bundle", () => {
    const source = roundTrip(
      s.function.run({ fn: { name: "gone", guid: "ffffffffffffffffffffffffffffffff" } }),
      EMPTY_REFS,
    );
    // Degrades to {name, guid} rather than a bare string, which ObjectRef would
    // read as a NAME and re-derive into a different guid.
    expect(source).toContain("ffffffffffffffffffffffffffffffff");
  });

  // `mvp:action` targets a MARKETPLACE action-package version, not a workspace
  // object, so its id is never in the bundle's object graph and reporting it as
  // a missing guid is a false error. All 3 in the survey corpus were absent, and
  // one of them appeared in two different workspaces — which a workspace-local
  // guid cannot do.
  it("does not report an action.call target as an unresolved workspace reference", () => {
    const ctx = new DecodeContext();
    const stored = encodeStatement(
      s.action.call({ action: { name: "", guid: "20c63dfc-dfcf-420e-8435-8212d1a8305d" } }),
    ) as StackItemXdo;
    const source = printExpr(decodeStatement(ctx, EMPTY_REFS, stored, {}));

    expect(source).toContain("20c63dfc-dfcf-420e-8435-8212d1a8305d");
    expect(ctx.report.entries.filter((e) => e.category === "blank-binding")).toEqual([]);
    // The bytes are unchanged by the fix — only the report is.
    expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
  });

  it("still reports a FUNCTION call whose target is genuinely missing", () => {
    // The paired negative: skipping resolution is scoped to the external
    // surface, so an ordinary workspace call must keep reporting.
    const ctx = new DecodeContext();
    const stored = encodeStatement(
      s.function.run({ fn: { name: "gone", guid: "ffffffffffffffffffffffffffffffff" } }),
    ) as StackItemXdo;
    printExpr(decodeStatement(ctx, EMPTY_REFS, stored, {}));
    expect(ctx.report.entries.some((e) => e.category === "unresolved-ref")).toBe(true);
  });
});

describe("misc specials", () => {
  it("round-trips comment, whose text rides the envelope description", () => {
    expect(roundTrip(s.comment("explain this"))).toContain("explain this");
    roundTrip(s.comment());
  });

  it("round-trips placeholder and the terminal statements", () => {
    roundTrip(s.placeholder("todo"));
    roundTrip(s.return(ref("result")));
    roundTrip(s.debug.log({ value: c.text("here") }));
  });

  it("round-trips util.post_process's nested stack", () => {
    expect(roundTrip(s.util.post_process([s.set_var("x", c.int(1))]))).toContain(
      "s.util.post_process(",
    );
  });

  it("round-trips expect.to_throw with and without an expected exception", () => {
    roundTrip(s.expect.to_throw({ body: [s.set_var("x", c.int(1))] }));
    roundTrip(s.expect.to_throw({ body: [], exception: c.text("Boom") }));
  });
});

describe("dispatch ordering", () => {
  it("prefers a special over the spec arm for a name both could claim", () => {
    // `precondition` is spec-driven; `conditional` is a special. The special
    // registry is consulted first, so a name in both resolves to the special.
    const stored: StackItemXdo = encodeStatement(
      s.conditional({ when: expr(ref("a"), "=", c.int(1)), then: [] }),
    );
    const ctx = new DecodeContext();
    expect(printExpr(decodeStatement(ctx, EMPTY_REFS, stored))).toContain("s.conditional(");
    expect(ctx.report.entries).toEqual([]);
  });

  it("leaves no imports behind from a special that declined", () => {
    const ctx = new DecodeContext();
    ctx.beginFile();
    // A set_var whose context is not a tagged value cannot decode; the attempt
    // must not leave `s` or a value import in the committed file.
    const broken = { ...encodeStatement(s.set_var("x", c.int(1))), context: { nope: true } };
    decodeStatement(ctx, EMPTY_REFS, broken as StackItemXdo);
    expect(ctx.imports.toStatements().map((i) => i.module)).toEqual(["@sidestep/core/codegen"]);
  });
});

// ---------------------------------------------------------------------------
// U6 tranche 2 — the database family, AI/cloud, and the miscellaneous tail
// ---------------------------------------------------------------------------

const USERS = { name: "users", guid: "1111000000000000000000000000aaaa" };
const POSTS = { name: "posts", guid: "2222000000000000000000000000bbbb" };
const AUTHOR_ADDON = { name: "author", guid: "3333000000000000000000000000cccc" };
const ASSISTANT = { name: "assistant", guid: "4444000000000000000000000000dddd" };

/** A bundle index holding the tables, addon, and agent the db/AI tests reference. */
const DB_REFS = RefIndex.fromPayload(
  {
    dbo: [USERS, POSTS],
    addon: [AUTHOR_ADDON],
    toolset: [{ ...ASSISTANT, type: "agent" }],
  },
  new DecodeContext(),
);

/** The sibling bindings a generated file would import, by the symbol the decoder emits. */
const DB_SYMBOLS = {
  users: USERS,
  posts: POSTS,
  author: AUTHOR_ADDON,
  assistant: ASSISTANT,
};

/** Round-trip against the db bundle index, with every referenced object in scope. */
function dbRoundTrip(statement: Statement): string {
  return roundTrip(statement, DB_REFS, DB_SYMBOLS);
}

describe("database family", () => {
  it("round-trips enforceHiddenFields on all three statements that declare it", () => {
    // A security-relevant flag: with it on, the engine refuses to auto-wire
    // request inputs the endpoint never bound. The round trip is what proves the
    // encoder and decoder agree — the flag reaches the source AND re-encodes to
    // the same bytes.
    for (const built of [
      s.db.add({ table: USERS, data: [], enforceHiddenFields: true }),
      s.db.edit({ table: USERS, fieldValue: c.int(1), data: [], enforceHiddenFields: true }),
      s.db.add_or_edit({ table: USERS, fieldValue: c.int(1), data: [], enforceHiddenFields: true }),
    ]) {
      const source = dbRoundTrip(built);
      expect(source).not.toContain("raw(");
      expect(source).toContain("enforceHiddenFields: true");
    }
  });

  it("says nothing about enforceHiddenFields when it is off", () => {
    // Absent IS off, so recovering `enforceHiddenFields: false` would re-encode
    // to an absent key and fail its own proof — it must simply not appear.
    expect(dbRoundTrip(s.db.add({ table: USERS, data: [] }))).not.toContain("enforceHiddenFields");
  });

  it("round-trips every single-row operation, eliding the default `id` lookup column", () => {
    // `fieldName` omitted means the primary key, so the decoder must NOT emit it
    // back — and must emit it when the author named a different column.
    expect(dbRoundTrip(s.db.get({ table: USERS, fieldValue: inp("id"), as: "user" }))).not.toContain(
      "fieldName",
    );
    expect(
      dbRoundTrip(
        s.db.get({ table: USERS, fieldName: "email", fieldValue: inp("email"), as: "user" }),
      ),
    ).toContain('fieldName: "email"');
    dbRoundTrip(s.db.del({ table: USERS, fieldValue: inp("id") }));
    dbRoundTrip(s.db.has({ table: USERS, fieldName: "email", fieldValue: inp("email"), as: "hit" }));
    dbRoundTrip(
      s.db.patch({ table: USERS, fieldValue: inp("id"), data: c.obj({ name: "Renamed" }) }),
    );
    dbRoundTrip(s.db.schema({ table: USERS, path: c.text("email"), as: "colSchema" }));
  });

  it("round-trips the boolean-flagged operations at and away from their defaults", () => {
    // `lock`/`reset` are always stored (as `const:bool`), so the decoder has to
    // distinguish "author wrote false" from "author wrote nothing" by value.
    expect(dbRoundTrip(s.db.truncate({ table: POSTS }))).not.toContain("reset");
    expect(dbRoundTrip(s.db.truncate({ table: POSTS, reset: true }))).toContain("reset: true");
    expect(dbRoundTrip(s.db.get({ table: USERS, fieldValue: inp("id") }))).not.toContain("lock");
    expect(dbRoundTrip(s.db.get({ table: USERS, fieldValue: inp("id"), lock: true }))).toContain(
      "lock: true",
    );
  });

  it("round-trips row writes as explicit `data` entries, preserving each `ignore` flag", () => {
    // A `row:` partial expands against the schema into `data:` entries, so the
    // decoder's `data` form is the honest inverse of both authoring shapes.
    const source = dbRoundTrip(
      s.db.add({
        table: USERS,
        data: [
          { name: "id", value: c.null(), ignore: true },
          { name: "email", value: inp("email") },
        ],
        as: "created",
      }),
    );
    expect(source).toContain("ignore: true");
    dbRoundTrip(
      s.db.edit({
        table: USERS,
        fieldValue: inp("id"),
        data: [{ name: "votes", value: inp("votes") }],
        as: "updated",
      }),
    );
  });

  // R-C — the two nested shapes. Both were invisible before: neither could be
  // authored, so 14 row writes and 40 output blocks re-encoded flat and declined.
  describe("nested values", () => {
    /** Encode a statement, then hand-edit its stored bytes the way the engine stores them. */
    function restore(statement: Statement, edit: (stored: StackItemXdo) => void): StackItemXdo {
      const stored = structuredClone(encodeStatement(statement)) as StackItemXdo;
      edit(stored);
      return stored;
    }

    /** Decode stored bytes straight through, without going via the encoder first. */
    function decodeSource(stored: StackItemXdo): string {
      return printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored));
    }

    it("round-trips a row write whose column is assembled from sub-entries", () => {
      const source = dbRoundTrip(
        s.db.edit({
          table: USERS,
          fieldValue: inp("id"),
          data: [
            { name: "email", value: inp("email") },
            {
              name: "magic_link",
              value: ref("user.magic_link"),
              children: [
                { name: "token", value: ref("user.magic_link.token") },
                { name: "used", value: c.bool(true) },
              ],
            },
          ],
          as: "updated",
        }),
      );
      expect(source).toContain("children: [");
      expect(source).not.toContain("raw(");
    });

    it("declines when `expand` and `children` disagree, rather than re-encoding a third shape", () => {
      // The encoder derives `expand` from having children, so it cannot reproduce
      // a tree where they disagree. Neither disagreeing combination occurs in the
      // wild; `raw()` keeps the stored bytes exactly.
      const stored = restore(
        s.db.add({ table: USERS, data: [{ name: "email", value: inp("email") }] }),
        (bytes) => {
          (bytes.input as Array<Record<string, unknown>>)[0]!.expand = true;
        },
      );
      const source = decodeSource(stored);
      expect(source).toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("declines sub-entries on a lookup entry, which has no authored home for them", () => {
      const stored = restore(
        s.db.get({ table: USERS, fieldValue: inp("id"), as: "user" }),
        (bytes) => {
          const entry = (bytes.input as Array<Record<string, unknown>>)[1]!;
          entry.expand = true;
          entry.children = [
            { name: "x", value: "1", tag: "const:int", filters: [], ignore: false, expand: false, children: [] },
          ];
        },
      );
      const source = decodeSource(stored);
      expect(source).toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("round-trips a nested output selection as dotted paths", () => {
      const source = dbRoundTrip(
        s.db.get({
          table: USERS,
          fieldValue: inp("id"),
          output: ["id", "password_reset.token", "password_reset.used"],
          as: "user",
        }),
      );
      expect(source).toContain('"password_reset.token"');
      expect(source).not.toContain("raw(");
    });

    it("round-trips a nested selection inside an addon's own output", () => {
      const source = dbRoundTrip(
        s.db.get({
          table: USERS,
          fieldValue: inp("id"),
          addon: [{ addon: AUTHOR_ADDON, as: "_author", output: ["name", "img.url"] }],
          as: "user",
        }),
      );
      expect(source).toContain('"img.url"');
      expect(source).not.toContain("raw(");
    });

    it("declines a selected column whose own name contains a dot", () => {
      // Emitting it as a path would re-encode as two levels, silently changing
      // which column is selected — so it stays raw().
      const stored = restore(
        s.db.get({ table: USERS, fieldValue: inp("id"), output: ["id"], as: "user" }),
        (bytes) => {
          (bytes.output as { items: Array<Record<string, unknown>> }).items[0]!.name = "a.b";
        },
      );
      const source = decodeSource(stored);
      expect(source).toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });
  });

  it("round-trips add_or_edit, whose lean shape stores the table name beside the guid", () => {
    dbRoundTrip(
      s.db.add_or_edit({
        table: USERS,
        fieldName: "email",
        fieldValue: inp("email"),
        data: [{ name: "name", value: inp("name") }],
        as: "upserted",
      }),
    );
  });

  it("round-trips the bulk operations, including the one filtered by context.search", () => {
    dbRoundTrip(s.db.bulk.add({ table: USERS, items: c.array([{ email: "a@example.com" }]) }));
    dbRoundTrip(s.db.bulk.add({ table: USERS, items: ref("rows"), allowIdField: true }));
    dbRoundTrip(s.db.bulk.patch({ table: USERS, items: ref("rows"), as: "patched" }));
    dbRoundTrip(s.db.bulk.update({ table: USERS, items: ref("rows") }));
    dbRoundTrip(
      s.db.bulk.delete({
        table: POSTS,
        where: expr(col("published"), "=", c.bool(false)),
        as: "deleted",
      }),
    );
    // No `where` at all is a distinct stored shape (no `context.search`) — and a
    // semantically loud one, since it deletes every row.
    dbRoundTrip(s.db.bulk.delete({ table: POSTS, as: "deleted" }));
  });

  it("round-trips raw SQL against the workspace and every external engine", () => {
    dbRoundTrip(s.db.direct_query({ sql: "SELECT 1", as: "rows" }));
    expect(
      dbRoundTrip(
        s.db.direct_query({
          sql: "SELECT * FROM users WHERE id = ?",
          responseType: "single",
          args: [inp("id")],
          as: "row",
        }),
      ),
    ).toContain('responseType: "single"');
    for (const engine of ["mssql", "mysql", "oracle", "postgres", "snowflake"] as const) {
      const source = dbRoundTrip(
        s.db.external[engine].direct_query({
          sql: "SELECT 1",
          connectionString: env("DB_URL"),
          args: [inp("id")],
          as: "rows",
        }),
      );
      expect(source).toContain(`s.db.external.${engine}.direct_query(`);
    }
  });

  it("reports a never-configured raw-SQL statement as a stub, not as a decode failure", () => {
    // Dragged onto a stack and never touched. There is no SQL, no connection and
    // no arguments to recover because none was ever stored — so `raw()` is the
    // faithful output, not a decoder giving up. Six rows in the survey corpus
    // were claiming the opposite.
    for (const name of [
      "mvp:dbo_direct_query",
      "mvp:dbo_external_mysql_query",
      "mvp:dbo_external_mssql_query",
      "mvp:dbo_external_oracle_query",
      "mvp:dbo_external_postgres_query",
    ]) {
      const ctx = new DecodeContext();
      const source = printExpr(decodeStatement(ctx, DB_REFS, { name, context: {} } as never));
      expect(source).toContain("raw(");
      expect(ctx.report.entries.map((e) => e.category)).toEqual(["unconfigured-stub"]);
      // The sentence a reader gets is the one written for them. It used to lose
      // a first-writer-wins race with the terser guard label and never shipped.
      expect(ctx.report.entries[0]!.detail).toContain("never configured");
      expect(ctx.report.entries[0]!.detail).toContain("unconfigured stub");
      expect(ctx.report.entries[0]!.detail).not.toContain("could not reproduce");
    }
  });

  it("still calls a PARTIALLY configured statement a fallback", () => {
    // The load-bearing negative: an empty context is the only trigger. A
    // statement with something in it that the decoder could not spell is a real
    // fidelity gap and keeps its warning.
    const ctx = new DecodeContext();
    printExpr(
      decodeStatement(ctx, DB_REFS, {
        name: "mvp:dbo_direct_query",
        context: { code: 42 },
      } as never),
    );
    expect(ctx.report.entries.map((e) => e.category)).toEqual(["raw-fallback"]);
  });

  it("round-trips a transaction, decoding its nested stack through the full dispatch", () => {
    const source = dbRoundTrip(
      s.db.transaction({
        body: [
          s.db.add({ table: USERS, data: [{ name: "email", value: inp("email") }], as: "u" }),
          s.set_var("done", c.bool(true)),
        ],
      }),
    );
    expect(source).toContain("s.db.transaction(");
    expect(source).toContain("s.db.add(");
  });

  it("keeps an unmodelled statement raw at depth inside a transaction", () => {
    const stored = encodeStatement(
      s.db.transaction({ body: [raw({ name: "mvp:not_a_real_statement", context: { x: 1 } })] }),
    );
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, DB_REFS, stored));
    expect(source).toContain("s.db.transaction(");
    expect(source).toContain("raw(");
    expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
  });
});

describe("db family — an unbound table", () => {
  /** Re-point a statement's `context.dbo` at nothing, the way a deleted table leaves it. */
  function unbind(statement: Statement, dbo: Record<string, unknown> = { id: "" }): StackItemXdo {
    const stored = encodeStatement(statement);
    return {
      ...stored,
      context: { ...(stored.context as Record<string, unknown>), dbo },
    } as StackItemXdo;
  }

  // `dboOp` drives eleven statements off one table-reading path, so the state has
  // to hold across the shapes: a lookup op, a row-write, and a bulk op.
  const CASES: ReadonlyArray<readonly [string, Statement]> = [
    ["s.db.get(", s.db.get({ table: USERS, fieldValue: inp("id"), as: "user" })],
    ["s.db.del(", s.db.del({ table: USERS, fieldValue: inp("id") })],
    ["s.db.add(", s.db.add({ table: USERS, data: [{ name: "email", value: inp("email") }] })],
    ["s.db.edit(", s.db.edit({ table: USERS, fieldValue: inp("id"), data: [{ name: "email", value: inp("email") }] })],
    ["s.db.bulk.add(", s.db.bulk.add({ table: USERS, items: inp("rows") })],
  ];

  for (const [surface, statement] of CASES) {
    it(`decodes ${surface}…) with a blank dbo.id as \`table: null\``, () => {
      const stored = unbind(statement);
      const source = printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored));
      expect(source).toContain(surface);
      expect(source).toContain("table: null");
      expect(source).not.toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });
  }

  it("keeps every other recovered argument alongside the unbound table", () => {
    // The table going null must not quietly take the rest of the statement with it.
    const stored = unbind(
      s.db.get({ table: USERS, fieldName: "email", fieldValue: inp("email"), as: "user" }),
    );
    const source = printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored));
    expect(source).toContain('fieldName: "email"');
    expect(source).toContain("fieldValue: inp(");
    expect(source).toContain('as: "user"');
    expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
  });

  it("REPORTS a blank table reference rather than presenting it as deliberate", () => {
    // A blank reference has two indistinguishable causes: a deleted/never-bound
    // table, or a real one the export-side remap blanked because it sat outside the
    // export's scope. `table: null` is faithful to the bytes either way, but
    // emitting it silently would present a lost binding as an intentional one — so
    // the loss arrives as an error-severity line, the same contract the realtime
    // kinds already hold blank bindings to.
    const stored = unbind(s.db.get({ table: USERS, fieldValue: inp("id"), as: "user" }));
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, DB_REFS, stored));
    expect(source).toContain("table: null");

    const unresolved = ctx.report.entries.filter((e) => e.category === "blank-binding");
    expect(unresolved).toHaveLength(1);
    // One cause, named without a hedge. This flow pulls whole workspaces, so a
    // blank reference cannot be a live target that merely sat outside a scoped
    // export — the line used to offer that reading and send the reader to
    // re-pull, which is advice about a situation this SDK cannot produce.
    expect(unresolved[0]!.detail).toMatch(/deleted, or the binding was never made/);
    expect(unresolved[0]!.detail).not.toMatch(/scope/);
  });

  it("reports nothing for a table that resolves", () => {
    // The paired negative: no false alarm on a healthy reference.
    const ctx = new DecodeContext();
    printExpr(
      decodeStatement(
        ctx,
        DB_REFS,
        encodeStatement(s.db.get({ table: USERS, fieldValue: inp("id"), as: "user" })),
      ),
    );
    expect(ctx.report.entries.filter((e) => e.category === "blank-binding")).toEqual([]);
  });

  it("treats a zero numeric id as unbound, like a blank guid", () => {
    // A reference id is a guid OR a number depending on how the referring object
    // was saved, so the empty form has two spellings and both mean "no target".
    const stored = unbind(s.db.get({ table: USERS, fieldValue: inp("id"), as: "user" }), { id: 0 });
    const source = printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored));
    expect(source).toContain("table: null");
    expect(source).not.toContain("raw(");
    expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
  });

  it("declines a BOUND numeric reference rather than emit an unverifiable one", () => {
    // The load-bearing distinction. `normalize` strips `id` as a server column, so
    // a reference id is never byte-compared — the proof-carrying contract cannot
    // catch a wrong one here. Recovering `3` would re-encode it as the STRING "3",
    // a type change that would sail through unexamined, so it stays raw() until a
    // reference can carry its stored spelling.
    const stored = unbind(s.db.get({ table: USERS, fieldValue: inp("id"), as: "user" }), { id: 3 });
    const source = printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored));
    expect(source).toContain("raw(");
    expect(source).not.toContain("table: null");
    expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
  });

  it("throws rather than guess when `row:` needs an unbound table's columns", () => {
    // `table: null` represents a broken statement; it does not author one. `row:`
    // expands against the table's schema, so it has nothing to work from — and a
    // decoded broken statement always carries `data:`, never `row:`.
    expect(() => s.db.add({ table: null, row: { email: c.text("x@y.z") } })).toThrow(
      /table` is null/,
    );
  });
});

describe("db.query", () => {
  it("round-trips a bare list query with none of the engine's paging defaults restated", () => {
    const source = dbRoundTrip(s.db.query({ table: POSTS, as: "rows" }));
    expect(source).toBe('s.db.query({\n  table: posts,\n  as: "rows",\n})');
  });

  // The engine writes `search: {expression: []}` on a join that filters on
  // nothing, exactly as it does on the query's own search. The top-level read
  // has always treated that as unauthored; the join's did not, and sent the
  // empty tree into the condition inverse — which cannot build one — so five
  // joined queries in the survey corpus fell back for filtering on nothing.
  it("reads an EMPTY bind[] join search as unauthored rather than a filter it cannot parse", () => {
    const stored = encodeStatement(
      s.db.query({ table: POSTS, bind: [{ table: USERS }], as: "rows" }),
    ) as StackItemXdo;
    const bind = (stored.context as { bind: Array<Record<string, unknown>> }).bind;
    bind[0]!.search = { expression: [] };

    const source = printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored, {}));
    expect(source).not.toContain("raw(");
    expect(source).not.toContain("where");
    expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
  });

  // Every expression node carries BOTH a `group` and a `statement`, and `type`
  // selects which is live — the engine's two walkers each switch on it and never
  // read the other. The empty `group` on a statement node was already dropped;
  // the blank `statement` on a GROUP node is the missing half.
  describe("the scaffolding on an expression node's dead branch", () => {
    const BLANK_STATEMENT = {
      op: "=",
      left: { tag: "const", filters: [], operand: "" },
      right: { tag: "const", filters: [], operand: "", ignore_empty: false },
    };

    /** `a AND (b OR c)` — the shape that carries a group node at the root. */
    function grouped(): StackItemXdo {
      return encodeStatement(
        s.db.query({
          table: POSTS,
          where: and(
            expr(col("published"), "=", c.bool(true)),
            or(expr(col("score"), ">", c.int(10)), expr(col("score"), "<", c.int(99))),
          ),
          as: "rows",
        }),
      ) as StackItemXdo;
    }

    /** The root group node the engine would hang its dead `statement` off. */
    function groupNode(stored: StackItemXdo): Record<string, unknown> {
      const expression = (
        stored.context as { search: { expression: Array<Record<string, unknown>> } }
      ).search.expression;
      const node = expression.find((e) => e.type === "group");
      expect(node, "the fixture must contain a group node").toBeDefined();
      return node!;
    }

    it("ignores the BLANK placeholder statement the engine writes there", () => {
      const stored = grouped();
      groupNode(stored).statement = BLANK_STATEMENT;

      const source = printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored, {}));
      expect(source).not.toContain("raw(");
      expect(source).toContain("or(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("drops a REAL leftover comparison too, and reports the discard", () => {
      // Where a non-blank one comes from: the editor copies the live condition
      // INTO the new group when you wrap it and does not clear the original, so
      // this is a frozen snapshot the UI never renders and no consumer reads.
      // Dropped rather than carried — but reported, because discarding stored
      // bytes should never be silent.
      const ctx = new DecodeContext();
      const stored = grouped();
      groupNode(stored).statement = {
        op: "!=",
        left: { tag: "var", filters: [], operand: "$this.predicted_in" },
        right: { tag: "const:null", filters: [], operand: "null", ignore_empty: false },
      };

      const source = printExpr(decodeStatement(ctx, DB_REFS, stored, {}));
      expect(source).not.toContain("raw(");
      expect(source).toContain("or(");
      // The leftover is gone from the tree, not smuggled into the condition.
      expect(source).not.toContain("predicted_in");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));

      const omissions = ctx.report.entries.filter((e) => e.category === "expected-omission");
      expect(omissions).toHaveLength(1);
      expect(omissions[0]!.detail).toContain("unused `statement` branch");
    });

    it("reports nothing when the dead branch is the blank placeholder", () => {
      // Pure scaffolding — every group node the SDK itself writes has one, so
      // reporting it would be noise on every single grouped condition.
      const ctx = new DecodeContext();
      const stored = grouped();
      groupNode(stored).statement = BLANK_STATEMENT;
      printExpr(decodeStatement(ctx, DB_REFS, stored, {}));
      expect(ctx.report.entries.filter((e) => e.category === "expected-omission")).toEqual([]);
    });
  });

  it("preserves a nested where-tree's structure and join mode", () => {
    // The `or` flag rides the second sibling, so an and/or mix is exactly where a
    // naive inverse flattens the tree into the wrong logic.
    const source = dbRoundTrip(
      s.db.query({
        table: POSTS,
        where: and(
          expr(col("published"), "=", c.bool(true)),
          or(expr(col("score"), ">", c.int(10)), cmp(col("tags"), "overlaps", inp("t"))),
        ),
        as: "rows",
      }),
    );
    expect(source).toContain("and(");
    expect(source).toContain("or(");
    expect(source).toContain("cmp(");
  });

  it("round-trips a raw Value where — the escape hatch that is not an expression tree", () => {
    dbRoundTrip(s.db.query({ table: POSTS, where: inp("filters"), as: "rows" }));
  });

  it("merges where and additionalWhere into the single search the engine reads", () => {
    // The encoder concatenates both into one ANDed `expression[]`, so the decode
    // is deliberately lossy in *authoring shape* while exact in stored bytes.
    dbRoundTrip(
      s.db.query({
        table: POSTS,
        where: expr(col("published"), "=", c.bool(true)),
        additionalWhere: expr(col("score"), ">", c.int(0)),
        as: "rows",
      }),
    );
  });

  it("round-trips sort, dropping the implicit ascending direction", () => {
    expect(
      dbRoundTrip(s.db.query({ table: POSTS, sort: [{ sortBy: "score" }], as: "rows" })),
    ).not.toContain("dir");
    expect(
      dbRoundTrip(
        s.db.query({ table: POSTS, sort: [{ sortBy: "score", dir: "desc" }], as: "rows" }),
      ),
    ).toContain('dir: "desc"');
  });

  it("round-trips static and input-bound paging, which store in different places", () => {
    // A numeric page rides the static block; a `Value` page rides
    // `context.simpleExternal` while the static block stays at its default — so
    // reading only one of the two would silently drop the binding.
    expect(dbRoundTrip(s.db.query({ table: POSTS, paging: { per_page: 10 }, as: "p" }))).toContain(
      "per_page: 10",
    );
    dbRoundTrip(
      s.db.query({ table: POSTS, paging: { page: inp("page"), per_page: 10 }, as: "p" }),
    );
    dbRoundTrip(
      s.db.query({
        table: POSTS,
        paging: { page: 2, offset: 5, totals: true, metadata: false },
        as: "p",
      }),
    );
    dbRoundTrip(
      s.db.query({ table: POSTS, paging: { search: inp("q"), sort: inp("s") }, as: "p" }),
    );
  });

  it("round-trips every return type with its own sort/paging sub-schema", () => {
    for (const returnType of ["single", "count", "exists"] as const) {
      expect(dbRoundTrip(s.db.query({ table: POSTS, returnType, as: "r" }))).toContain(
        `returnType: "${returnType}"`,
      );
    }
    dbRoundTrip(
      s.db.query({ table: POSTS, returnType: "single", sort: [{ sortBy: "id" }], as: "r" }),
    );
    // Stream paging is `{page, per_page}` only — no offset/metadata/totals.
    dbRoundTrip(
      s.db.query({
        table: POSTS,
        returnType: "stream",
        paging: { per_page: 100 },
        distinct: "yes",
        as: "r",
      }),
    );
  });

  it("round-trips an aggregate, unqualifying the group/eval names the encoder prefixed", () => {
    // The encoder rewrites a bare `published` to `posts.published`; the decoder
    // must strip the primary alias back off, and re-qualification must land on
    // the identical stored name.
    const source = dbRoundTrip(
      s.db.query({
        table: POSTS,
        returnType: "aggregate",
        aggregate: {
          group: [{ name: "published", as: "published" }],
          eval: [{ name: "id", as: "count", filters: [{ name: "count" }] }],
          paging: { per_page: 50 },
        },
        as: "rollup",
      }),
    );
    expect(source).toContain('name: "published"');
    expect(source).not.toContain('name: "posts.published"');
  });

  it("round-trips joins, computed columns, and a row lock", () => {
    dbRoundTrip(
      s.db.query({
        table: POSTS,
        bind: [
          { table: USERS, where: expr(col("posts.author_id"), "=", col("users.id")) },
          { table: USERS, as: "editor", join: "left" },
        ],
        eval: [{ name: "score", as: "boosted", filters: [{ name: "multiply", arg: [c.int(2)] }] }],
        lock: true,
        as: "rows",
      }),
    );
  });

  it("round-trips the classic external blob, including a non-default permission gate", () => {
    dbRoundTrip(s.db.query({ table: POSTS, external: { value: inp("filters") }, as: "rows" }));
    expect(
      dbRoundTrip(
        s.db.query({
          table: POSTS,
          external: { value: inp("filters"), permissions: { per_page: true, sort: false } },
          as: "rows",
        }),
      ),
    ).toContain("permissions");
  });

  it("resolves an attached addon through the ref index and rejoins its dotted destination", () => {
    // With paging on, the encoder prefixes `items[]` onto the addon's offset; the
    // decoder rejoins offset + alias, and re-prefixing is idempotent.
    const source = dbRoundTrip(
      s.db.query({
        table: POSTS,
        paging: { per_page: 10 },
        addon: [{ addon: AUTHOR_ADDON, as: "_author", input: { user_id: out("author_id") } }],
        output: ["id", "title"],
        as: "rows",
      }),
    );
    expect(source).toContain("addon: author");
    expect(source).toContain('as: "items[]._author"');
  });

  it("round-trips a nested addon with its own output whitelist", () => {
    dbRoundTrip(
      s.db.query({
        table: POSTS,
        addon: [
          {
            addon: AUTHOR_ADDON,
            as: "_author",
            output: ["id", "email"],
            children: [{ addon: AUTHOR_ADDON, as: "_manager" }],
          },
        ],
        as: "rows",
      }),
    );
  });

  /**
   * The engine writes `search` / `bind` / `eval` unconditionally at their empty
   * defaults; the SDK's encoder omits them. `normalize` reconciles that by
   * dropping such a member from both sides, so the only correct reading of one is
   * "not authored" — but the decoder used to read an empty `search` as a filter it
   * had failed to parse. Measured on 187 real workspaces, that single
   * misinterpretation accounted for 113 of 201 fallen-back `db.query` statements.
   *
   * Each case here pairs with a negative one proving a POPULATED member is still
   * decoded rather than swept up by the same rule.
   */
  describe("the engine's empty context members", () => {
    /** A stored query with each member spelled the way the engine persists it. */
    function engineForm(overrides: Record<string, unknown> = {}): StackItemXdo {
      const stored = encodeStatement(s.db.query({ table: POSTS, as: "rows" }));
      return {
        ...stored,
        context: {
          ...(stored.context as Record<string, unknown>),
          search: { expression: [] },
          bind: [],
          eval: [],
          ...overrides,
        },
      } as StackItemXdo;
    }

    function decode(stored: StackItemXdo): string {
      return printExpr(decodeStatement(new DecodeContext(), DB_REFS, stored));
    }

    it("reads an empty search, bind, and eval as unauthored rather than unreadable", () => {
      const stored = engineForm();
      const source = decode(stored);
      expect(source).toContain("s.db.query(");
      expect(source).not.toContain("raw(");
      // None of the three may be restated — an empty member carries no information.
      for (const key of ["where:", "bind:", "eval:"]) expect(source).not.toContain(key);
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("still decodes a populated search on an otherwise engine-spelled query", () => {
      const withWhere = encodeStatement(
        s.db.query({ table: POSTS, where: expr(col("published"), "=", c.bool(true)), as: "rows" }),
      );
      const stored = engineForm({
        search: (withWhere.context as { search?: unknown }).search,
      });
      const source = decode(stored);
      expect(source).toContain("where: expr(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("still decodes a populated eval on an otherwise engine-spelled query", () => {
      const withEval = encodeStatement(
        s.db.query({ table: POSTS, eval: [{ name: "score", as: "s" }], as: "rows" }),
      );
      const stored = engineForm({ eval: (withEval.context as { eval?: unknown }).eval });
      const source = decode(stored);
      expect(source).toContain("eval:");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("reads an all-default simpleExternal as unauthored, not as five bound facets", () => {
      // The engine writes all five paging facets at an empty `input` default. Read
      // as authored they become bound Values, and because the engine honors
      // `external` over `simpleExternal` the SDK forbids authoring both — so this
      // did not merely mismatch, the recovered call THREW inside the factory.
      const withExternal = encodeStatement(
        s.db.query({ table: POSTS, external: { value: inp("filters") }, as: "rows" }),
      );
      const stored = {
        ...withExternal,
        context: {
          ...(withExternal.context as Record<string, unknown>),
          simpleExternal: {
            page: { tag: "input", value: "", filters: [] },
            sort: { tag: "input", value: "", filters: [] },
            offset: { tag: "input", value: "", filters: [] },
            search: { tag: "input", value: "", filters: [] },
            per_page: { tag: "input", value: "", filters: [] },
          },
        },
      } as StackItemXdo;
      const source = decode(stored);
      expect(source).toContain("external:");
      expect(source).not.toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("still decodes genuinely bound paging facets from simpleExternal", () => {
      // The paired negative: the rule above must not swallow a real input binding.
      const source = dbRoundTrip(
        s.db.query({ table: POSTS, paging: { page: inp("page"), per_page: inp("size") }, as: "p" }),
      );
      expect(source).toContain("page: inp(");
      expect(source).toContain("per_page: inp(");
    });

    it("decodes an unbound table as `table: null` rather than declining", () => {
      // A statement whose table was deleted stores a blank `context.dbo.id`. That
      // is a state the authoring surface models deliberately — the same contract
      // an addon's `table` has always carried — so reading it as "no reference to
      // recover" degraded 83 db statements to raw() across the sweep.
      const bound = encodeStatement(s.db.query({ table: POSTS, as: "rows" }));
      const stored = {
        ...bound,
        context: { ...(bound.context as Record<string, unknown>), dbo: { id: "" } },
      } as StackItemXdo;
      const source = decode(stored);
      expect(source).toContain("table: null");
      expect(source).not.toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("keeps an unbound table's surviving alias", () => {
      // A deleted table's alias routinely outlives it (`{as: "user", id: ""}`), and
      // it is read by presence like every other `dbo.as`.
      const bound = encodeStatement(s.db.query({ table: POSTS, as: "rows" }));
      const stored = {
        ...bound,
        context: { ...(bound.context as Record<string, unknown>), dbo: { as: "user", id: "" } },
      } as StackItemXdo;
      const source = decode(stored);
      expect(source).toContain("table: null");
      expect(source).toContain('tableAlias: "user"');
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("still resolves a bound table to its symbol", () => {
      // The paired negative: `null` must not become the lazy answer for a table
      // that is perfectly resolvable.
      const source = dbRoundTrip(s.db.query({ table: POSTS, as: "rows" }));
      expect(source).toContain("table: posts");
      expect(source).not.toContain("table: null");
    });

    it("authors the paging gate back when the encoder's derivation disagrees", () => {
      // Real workspaces persist a non-default `per_page` with the gate OFF, which a
      // derive-only encoder cannot reproduce. ~158 of the remaining `db.query`
      // mismatches traced to this one thing, because the same derivation also
      // decides where addons graft (`items[]`).
      const derived = encodeStatement(
        s.db.query({ table: POSTS, paging: { per_page: 10 }, as: "rows" }),
      );
      const ret = (derived.context as { return: { list: { paging: Record<string, unknown> } } }).return;
      const stored = {
        ...derived,
        context: {
          ...(derived.context as Record<string, unknown>),
          return: { ...ret, list: { ...ret.list, paging: { ...ret.list.paging, enabled: false } } },
        },
      } as StackItemXdo;
      const source = decode(stored);
      expect(source).toContain("enabled: false");
      expect(source).toContain("per_page: 10");
      expect(source).not.toContain("raw(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });

    it("stays silent about the gate when the derivation already agrees", () => {
      // The paired negative for readability: the gate must not appear on every
      // query just because it is now expressible.
      const source = dbRoundTrip(s.db.query({ table: POSTS, paging: { per_page: 10 }, as: "rows" }));
      expect(source).toContain("per_page: 10");
      expect(source).not.toContain("enabled");
    });

    it("falls back to raw() rather than dropping a search it cannot read", () => {
      // The load-bearing negative: the rule above must not become a licence to
      // discard a filter. A malformed operand is unreadable, and a query whose
      // filter cannot be recovered has to stay exact-but-unreadable.
      const stored = engineForm({
        search: { expression: [{ statement: { op: "=", left: {}, right: {} } }] },
      });
      const source = decode(stored);
      expect(source).toContain("raw(");
      expect(source).not.toContain("s.db.query(");
      expect(normalize(encodeStatement(evaluate(source, DB_SYMBOLS)))).toEqual(normalize(stored));
    });
  });
});

describe("AI agent and cloud jobs", () => {
  it("round-trips an agent run, whose target rides context and mode rides runtime", () => {
    const source = dbRoundTrip(
      s.ai.agent.run({ agent: ASSISTANT, args: inp("question"), as: "answer" }),
    );
    expect(source).toContain("agent: assistant");
    // `runtime` is written only when a mode was authored — absence is meaningful.
    expect(source).not.toContain("runtime");
    // The engine reads the same top-level block here as on `function.run`, so
    // only the real `async-*` vocabulary means anything.
    expect(
      dbRoundTrip(
        s.ai.agent.run({ agent: ASSISTANT, runtime: { mode: "async-shared" }, as: "answer" }),
      ),
    ).toContain('mode: "async-shared"');
    dbRoundTrip(
      s.ai.agent.run({
        agent: ASSISTANT,
        args: inp("q"),
        allowToolExecution: c.bool(true),
        version: c.int(2),
        as: "answer",
      }),
    );
  });

  it("round-trips cloud jobs, whose optional entries are recovered positionally", () => {
    roundTrip(s.cloud.job({ image: c.text("alpine"), as: "job" }));
    roundTrip(
      s.cloud.job({
        image: c.text("alpine"),
        command: c.text("run"),
        args: c.array(["-v"]),
        secret: ref("secret"),
        template: c.text("tpl"),
        await: c.int(120),
        as: "job",
      }),
    );
    roundTrip(s.cloud.job.await({ ids: ref("job"), timeout: c.int(60), as: "done" }));
    roundTrip(s.cloud.job.status({ id: ref("job"), as: "status" }));
  });
});

describe("miscellaneous specials", () => {
  it("round-trips raw-input capture at and away from its two stored defaults", () => {
    // Both entries are always persisted, filled from `"json"`/`false`, so an
    // inverse that read presence rather than value would emit them every time.
    expect(roundTrip(s.util.get_input({ as: "body" }))).toBe(
      's.util.get_raw_input({\n  as: "body",\n})',
    );
    expect(
      roundTrip(
        s.util.get_raw_input({ encoding: c.text("raw"), excludeMiddleware: c.bool(true), as: "raw" }),
      ),
    ).toContain('encoding: c.text("raw")');
  });

  it("round-trips the array set operations through their renamed context keys", () => {
    expect(roundTrip(s.array.map({ source: ref("items"), as: "mapped" }))).toContain(
      "s.array.map(",
    );
    roundTrip(s.array.map({ source: ref("items"), transform: ref("$$"), as: "mapped" }));
    roundTrip(s.array.union({ source: ref("a"), as: "u" }));
    roundTrip(s.array.union({ source: ref("a"), with: ref("b"), transform: ref("$$"), as: "u" }));
  });

  it("round-trips array.map's OBJECT mode back to the record transform", () => {
    const emitted = roundTrip(
      s.array.map({ source: ref("items"), as: "rows", transform: { id: ref("$this"), n: ref("$index") } }),
    );
    expect(emitted).toContain("transform: {");
    expect(emitted).toContain('id: ref("$this")');
    expect(emitted).toContain('n: ref("$index")');
  });

  it("reads an EDITOR-saved array.map, which stores both mapping branches", () => {
    // The editor builds its form from the whole context schema and saves the
    // entire form value, so it persists the branch `output_type` does not select:
    // an object-mode save also carries `transform_value` at the schema defaults
    // (`value?="$this"`, `tag?=var`), and a value-mode save carries
    // `transform_object: []`. The engine reads neither. Without this the SDK's
    // minimal spelling would not match the stored one and both would ride raw().
    const objectMode = {
      name: "mvp:array_map",
      as: "rows",
      input: [],
      output: { filters: [] },
      context: {
        output_type: "object",
        collection: { value: "items", tag: "var", filters: [] },
        transform_value: { value: "$this", tag: "var", filters: [] },
        transform_object: [
          {
            attribute_key: { value: "id", tag: "const", filters: [] },
            attribute_value: { value: "$this", tag: "var", filters: [] },
          },
        ],
      },
    } as unknown as StackItemXdo;
    const objectSource = printExpr(decodeStatement(new DecodeContext(), EMPTY_REFS, objectMode));
    expect(objectSource).not.toContain("raw(");
    expect(objectSource).toContain('id: ref("$this")');
    expect(normalize(encodeStatement(evaluate(objectSource)))).toEqual(normalize(objectMode));

    const valueMode = {
      name: "mvp:array_map",
      as: "doubled",
      input: [],
      output: { filters: [] },
      context: {
        output_type: "value",
        collection: { value: "items", tag: "var", filters: [] },
        transform_value: { value: "$this", tag: "var", filters: [] },
        transform_object: [],
      },
    } as unknown as StackItemXdo;
    const valueSource = printExpr(decodeStatement(new DecodeContext(), EMPTY_REFS, valueMode));
    expect(valueSource).not.toContain("raw(");
    expect(normalize(encodeStatement(evaluate(valueSource)))).toEqual(normalize(valueMode));
  });

  it("declines an object-mode array.map whose dead branch holds something REAL", () => {
    // Only the inert spelling is exhaust. A `transform_value` that is not the
    // schema default is a shape the SDK cannot write back, so it rides raw()
    // intact rather than being silently dropped.
    const stored = {
      name: "mvp:array_map",
      as: "rows",
      input: [],
      context: {
        output_type: "object",
        collection: { value: "items", tag: "var", filters: [] },
        transform_value: { value: "leftover", tag: "var", filters: [] },
        transform_object: [
          {
            attribute_key: { value: "id", tag: "const", filters: [] },
            attribute_value: { value: "$this", tag: "var", filters: [] },
          },
        ],
      },
    } as unknown as StackItemXdo;
    const source = printExpr(decodeStatement(new DecodeContext(), EMPTY_REFS, stored));
    expect(source).toContain("raw(");
    expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
  });

  it("declines array.map object mode with a COMPUTED key rather than inventing one", () => {
    // A record key has to be a literal. The engine allows a tagged value there,
    // so a filtered or non-const `attribute_key` has no authoring surface —
    // riding `raw()` keeps it byte-intact instead of silently renaming it.
    const stored = structuredClone(
      encodeStatement(
        s.array.map({ source: ref("items"), as: "rows", transform: { id: ref("$this") } }),
      ),
    ) as StackItemXdo;
    const attributes = (stored.context as { transform_object: Array<{ attribute_key: { tag: string } }> })
      .transform_object;
    attributes[0]!.attribute_key.tag = "var";

    const source = printExpr(decodeStatement(new DecodeContext(), EMPTY_REFS, stored));
    expect(source).toContain("raw(");
    // Still byte-exact — declining is what fidelity looks like here.
    expect(normalize(encodeStatement(evaluate(source)))).toEqual(normalize(stored));
  });

  it("round-trips a realtime event with and without an auth table", () => {
    roundTrip(s.api.realtime_event({ channel: c.text("room"), data: ref("payload"), authId: c.int(0) }));
    dbRoundTrip(
      s.api.realtime_event({
        channel: c.text("room"),
        data: ref("payload"),
        authTable: USERS,
        authId: auth("id"),
      }),
    );
  });

  it("reads the editor's `dbo_id: 0` as the auth table the SDK omits", () => {
    // The editor's form materializes both auth members always and writes 0 for
    // "no table bound"; the SDK writes nothing. The engine coalesces a missing
    // id to 0, and a live round trip showed it does not materialize the member
    // on the way in — so the two are one state, and the stored spelling must not
    // cost the statement its readability.
    const stored = encodeStatement(
      s.api.realtime_event({ channel: c.text("room"), data: ref("payload"), authId: c.int(0) }),
    ) as unknown as { context: { auth: Record<string, unknown> } };
    stored.context.auth = { dbo_id: 0, ...stored.context.auth };

    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, DB_REFS, stored as never));
    expect(source).not.toContain("raw(");
    expect(source).toContain("s.api.realtime_event(");
    // Recovered as unbound — never as a table, and never as a literal 0.
    expect(source).not.toContain("authTable");
    expect(source).not.toContain("dbo_id");
  });

  it("still reads a BOUND auth table rather than dropping it", () => {
    // The guard on the rule above: it fires on `0` alone, so a real table id
    // must survive. Without this, "unbound" would quietly mean "any".
    const stored = encodeStatement(
      s.api.realtime_event({
        channel: c.text("room"),
        data: ref("payload"),
        authTable: USERS,
        authId: auth("id"),
      }),
    ) as unknown as { context: { auth: Record<string, unknown> } };
    // A bound table rides as a GUID, so it can never equal the `0` sentinel.
    expect(stored.context.auth["dbo_id"]).toBe(USERS.guid);
    const normalized = normalize(stored) as { context: { auth: Record<string, unknown> } };
    expect(normalized.context.auth["dbo_id"]).toBe(stored.context.auth["dbo_id"]);
  });

  it("round-trips a realtime publish, minimal and full", () => {
    // Minimal: the three required keys and nothing else — the optionals must NOT
    // be materialized on the way back, or the regenerated source writes bytes the
    // engine never held.
    const minimal = roundTrip(
      s.realtime.publish({ server: "chat", channel: c.text("rooms/42"), data: ref("payload") }),
    );
    expect(minimal).toContain("s.realtime.publish(");
    expect(minimal).not.toContain("message");
    expect(minimal).not.toContain("authId");

    const full = dbRoundTrip(
      s.realtime.publish({
        server: "chat",
        channel: c.text("rooms/42"),
        data: ref("payload"),
        message: c.text("post"),
        authTable: USERS,
        authId: auth("id"),
      }),
    );
    expect(full).toContain('message: c.text("post")');
  });

  it("regenerates a realtime publish server as a plain name, not a reference lookup", () => {
    // The engine resolves the server BY NAME here (unlike a channel's own server
    // reference, which is a guid), so the decoded source must not route it through
    // the reference index.
    const src = roundTrip(
      s.realtime.publish({ server: "chat", channel: c.text("lobby"), data: ref("payload") }),
    );
    expect(src).toContain('server: "chat"');
  });

  it("round-trips a realtime publish whose server is computed rather than literal", () => {
    const src = roundTrip(
      s.realtime.publish({ server: inp("server_name"), channel: c.text("lobby"), data: ref("payload") }),
    );
    expect(src).toContain('inp("server_name")');
  });

  it("round-trips a realtime publish carrying only half an auth block", () => {
    const idOnly = roundTrip(
      s.realtime.publish({
        server: "chat",
        channel: c.text("lobby"),
        data: ref("payload"),
        authId: auth("id"),
      }),
    );
    expect(idOnly).not.toContain("authTable");
    dbRoundTrip(
      s.realtime.publish({
        server: "chat",
        channel: c.text("lobby"),
        data: ref("payload"),
        authTable: USERS,
      }),
    );
  });

  it("round-trips auth-token minting, eliding the encoder's `{}` and 24h defaults", () => {
    expect(
      dbRoundTrip(s.security.create_auth_token({ table: USERS, id: ref("user.id"), as: "token" })),
    ).not.toContain("expiration");
    expect(
      dbRoundTrip(
        s.security.create_auth_token({
          table: USERS,
          id: ref("user.id"),
          extras: c.obj({ role: "admin" }),
          expiration: c.int(3600),
          as: "token",
        }),
      ),
    ).toContain("expiration");
  });

  it("carries an auth table whose dbtable does not resolve as a guid", () => {
    // `dbtable` has three stored spellings: a guid that resolves (179 of 197
    // across the sweep), blank (5), and one that does not resolve (13) — which
    // older workspaces produce by storing the table's NAME here.
    //
    // SideStep resolves by guid ONLY and does not map the name back to the
    // table, so whether a table of that name is in the bundle changes nothing.
    // The old message asserted the value WAS a guid and named it as missing;
    // guids are arbitrary unique keys anyone can change, so there is no shape
    // to justify that claim, and the report now states only what is known.
    const stored = encodeStatement(
      s.security.create_auth_token({ table: USERS, id: ref("user.id"), as: "token" }),
    ) as StackItemXdo;
    const entry = (stored.input as Array<{ name: string; value: string }>).find(
      (e) => e.name === "dbtable",
    )!;
    entry.value = "users";

    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, DB_REFS, stored));
    // Carried verbatim, so it re-encodes to the same bytes. Resolving it to the
    // table's symbol would write the table's real guid instead and break that.
    expect(source).toContain('guid: "users"');
    expect(source).not.toContain("s.raw");
    expect(ctx.report.entries.map((e) => e.category)).toEqual(["name-bound-ref"]);
    expect(ctx.report.entries[0]!.detail).toContain("by guid only");
    // The load-bearing negative: not the old `guid users is not present in this
    // bundle`, which called the value a guid on no evidence.
    expect(ctx.report.entries[0]!.detail).not.toMatch(/^guid /);
  });

  it("round-trips the call-family tail that does not share the uniform call shape", () => {
    roundTrip(s.action.package.call({ action: "", package: "acme/thing", input: { a: c.int(1) } }));
    roundTrip(
      s.workflow_test.call({
        workflowTest: { name: "smoke", guid: "5555000000000000000000000000eeee" },
        datasource: "test",
        as: "result",
      }),
    );
  });
});

/**
 * U5 — the envelope members no factory takes. `description` and `disabled` are
 * authored in the editor and written by the encoder, but a decoder that rebuilds a
 * statement by calling its factory cannot reproduce either, so every annotated or
 * disabled statement used to degrade to `raw()`.
 *
 * `disabled` is the engine's commented-out state: the step stays in the stack and
 * the run engine skips it. Both proof arms are covered — `set_var` and `foreach`
 * reach a hand-written special, `security.create_uuid` a declarative spec.
 */
describe("envelope passthrough — description and disabled", () => {
  it("round-trips a disabled statement through the specials arm", () => {
    const source = roundTrip({ ...s.set_var("total", c.int(0)), disabled: true });
    expect(source).toContain("disabled: true");
    expect(source).not.toContain("raw(");
  });

  it("round-trips a disabled statement through the spec arm", () => {
    const source = roundTrip({ ...s.security.create_uuid({ as: "id" }), disabled: true });
    expect(source).toContain("disabled: true");
    expect(source).not.toContain("raw(");
  });

  it("emits nothing for the default enabled state", () => {
    const source = roundTrip(s.set_var("total", c.int(0)));
    expect(source).toBe('s.set_var("total", c.int(0))');
    expect(source).not.toContain("disabled");
  });

  it("emits nothing for an explicit disabled:false", () => {
    // The default is implicit; writing it would be noise the normalizer elides.
    const source = roundTrip({ ...s.set_var("total", c.int(0)), disabled: false });
    expect(source).not.toContain("disabled");
  });

  it("carries description and disabled together, description first", () => {
    const source = roundTrip({
      ...s.set_var("total", c.int(0)),
      description: "skipped for now",
      disabled: true,
    });
    expect(source).toContain('description: "skipped for now"');
    expect(source).toContain("disabled: true");
    expect(source.indexOf("description")).toBeLessThan(source.indexOf("disabled"));
  });

  it("round-trips a disabled statement nested inside a loop", () => {
    const source = roundTrip(
      s.foreach({
        as: "row",
        list: ref("rows"),
        body: [{ ...s.set_var("x", c.int(1)), disabled: true }],
      }),
    );
    expect(source).toContain("disabled: true");
    expect(source).not.toContain("raw(");
  });

  it("round-trips a disabled statement nested inside a conditional", () => {
    const source = roundTrip(
      s.conditional({
        when: cmp(inp("a"), "==", c.int(1)),
        then: [{ ...s.set_var("x", c.int(1)), disabled: true }],
      }),
    );
    expect(source).toContain("disabled: true");
  });

  it("keeps a disabled statement's own arguments intact", () => {
    // The override must not swallow what the factory built.
    const source = roundTrip({
      ...s.set_var("name", withFilters(inp("raw"), fl.trim())),
      disabled: true,
    });
    expect(source).toContain("fl.trim()");
    expect(source).toContain("disabled: true");
  });
});
