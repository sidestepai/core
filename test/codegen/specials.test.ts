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
import { and, cmp, expr, or } from "../../src/statements/expression.js";
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
  withFilters, fl, rawValue, raw, expr, cmp, and, or,
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

  it("decodes an unbound call target as `fn: null`, on both mvp:function surfaces", () => {
    // A call whose target function was deleted stores a blank `context.function.id`
    // — an unbound reference, not a decode failure. 17 statements across the sweep.
    for (const [statement, expected] of [
      [s.function.run({ fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" } }), "s.function.run("],
      [s.service.function.run({ fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" } }), "s.service.function.run("],
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

  // The plan's headline discrimination case: one stored name, two surfaces.
  it("routes mvp:function by its stored context, not by name", () => {
    const plain = roundTrip(
      s.function.run({ fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" } }),
      REFS,
      CALL_SYMBOLS,
    );
    expect(plain).toContain("s.function.run(");
    expect(plain).not.toContain("service");

    const service = roundTrip(
      s.service.function.run({ fn: { name: "helper", guid: "aaaa000000000000000000000000aaaa" } }),
      REFS,
      CALL_SYMBOLS,
    );
    expect(service).toContain("s.service.function.run(");
  });

  it("keeps a non-default runtimeMode and omits the default one", () => {
    const target = { name: "helper", guid: "aaaa000000000000000000000000aaaa" };
    expect(roundTrip(s.service.function.run({ fn: target }), REFS)).not.toContain("runtimeMode");
    expect(
      roundTrip(s.service.function.run({ fn: target, runtimeMode: "dedicated" }), REFS),
    ).toContain("runtimeMode");
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
    expect(source).not.toContain("runtimeMode");
    expect(
      dbRoundTrip(s.ai.agent.run({ agent: ASSISTANT, runtimeMode: "dedicated", as: "answer" })),
    ).toContain('runtimeMode: "dedicated"');
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
