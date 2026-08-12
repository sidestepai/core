/**
 * What a `raw()` fallback SAYS about itself.
 *
 * Every fallback reported "<name> has no decoder". That is false whenever a
 * decoder exists and merely declined — 81 of 181 rows in a 187-workspace sweep
 * said it of `mvp:dbo_view`, `mvp:conditional` and `mvp:set_var`, all of which
 * have had decoders for a long time. Read literally it sends a maintainer to
 * write code that is already there.
 *
 * The two causes need different work, so the report names which one it is: a
 * statement nothing models is a COVERAGE gap, one whose decoder declined is a
 * FIDELITY gap inside a decoder that exists.
 */
import { describe, it, expect } from "vitest";
import { decodeStack } from "../../src/codegen/statement.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { printExpr } from "../../src/codegen/print.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { ignored, c, s, cmp, col } from "../../src/index.js";
import { encodeStatement } from "../../src/statements/statement.js";

function fallbackDetail(stored: Record<string, unknown>): string {
  const ctx = new DecodeContext();
  decodeStack(ctx, new RefIndex(), [stored as never], {} as never);
  const entry = ctx.report.entries.find((e) => e.category === "raw-fallback");
  return entry?.detail ?? "";
}

describe("raw() fallback reporting", () => {
  it("says a statement nothing models has no decoder", () => {
    const detail = fallbackDetail({ name: "mvp:not_a_real_statement", context: {} });
    expect(detail).toContain("has no decoder");
  });

  it("does NOT claim a modelled statement has no decoder", () => {
    // `mvp:dbo_view` is modelled. Whatever stops this one decoding, "no decoder"
    // is the wrong sentence — and the one that wasted maintainer time.
    const detail = fallbackDetail({ name: "mvp:dbo_view", context: {} });
    expect(detail).not.toContain("has no decoder");
    expect(detail).toContain("is modelled");
    expect(detail).toContain("could not reproduce");
  });
});

/**
 * `security.create_auth_token` against an UNBOUND auth table.
 *
 * The table guid is stored as a bare `const` input, and a blank one made
 * `resolveRef` throw inside the factory — which is not a local failure, it took
 * the whole statement to `raw()`. 5 of the remaining factory aborts in a
 * 187-workspace sweep were this.
 */
describe("create_auth_token with an unbound table", () => {
  const stored = (guid: string) => ({
    name: "mvp:create_auth",
    as: "token",
    context: {},
    input: [
      { name: "id", tag: "auth", value: "id", filters: [] },
      { name: "dbtable", tag: "const", value: guid, filters: [] },
    ],
  });

  it("recovers the statement with `table: null` instead of aborting to raw()", () => {
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, new RefIndex(), stored("") as never, {} as never));
    expect(source).not.toContain("raw(");
    expect(source).toContain("table: null");
  });

  it("still resolves a bound auth table", () => {
    const ctx = new DecodeContext();
    const source = printExpr(
      decodeStatement(ctx, new RefIndex(), stored(deriveGuid("dbo", "user")) as never, {} as never),
    );
    expect(source).not.toContain("table: null");
  });
});

/**
 * A conditional with NO condition — dropped into a stack and never filled in.
 *
 * 17 of the 20 conditional declines in a 187-workspace sweep were this: 9 store
 * `{expression: []}` and 8 store the empty associative-map form `[]`. Both are
 * authorable, and that is the whole point — `Condition` is
 * `SearchNode | SearchNode[]`, and `encodeComparison([])` produces exactly
 * `{expression: []}`, so an empty `when` reproduces the stored bytes. Nothing is
 * invented, and nothing the engine evaluates changes.
 */
describe("a conditional with an empty condition", () => {
  // The envelope a real stored conditional carries — all 17 empty ones in the
  // corpus store `elif: {run: []}`, which is what the factory writes back.
  const conditional = (expr: unknown) => ({
    name: "mvp:conditional",
    context: { expr, if: { run: [] }, elif: { run: [] }, else: { run: [] } },
  });

  for (const [label, expr] of [
    ["the {expression: []} spelling", { expression: [] }],
    ["the empty associative-map spelling", []],
  ] as const) {
    it(`recovers ${label} as an empty when, not raw()`, () => {
      const ctx = new DecodeContext();
      const source = printExpr(
        decodeStatement(ctx, new RefIndex(), conditional(expr) as never, {} as never),
      );
      expect(source).not.toContain("raw(");
      expect(source).toContain("when: []");
    });
  }

  /**
   * A db-search-only operator stored on a runtime-evaluated surface: the
   * encoder now refuses it (#260), so emitting `cmp(…, "in", …)` here would
   * generate a tree that throws the moment it loads — the same failure mode the
   * blank-`op` decline exists to avoid. `raw()` keeps the bytes exact.
   */
  it("declines a db-search-only operator instead of emitting a cmp() that throws", () => {
    const node = {
      or: false,
      type: "statement",
      group: { expression: [] },
      statement: {
        op: "in",
        left: { tag: "var", operand: "a", filters: [] },
        right: { tag: "const", operand: "[1,2]", filters: [] },
      },
    };
    const ctx = new DecodeContext();
    const source = printExpr(
      decodeStatement(ctx, new RefIndex(), conditional({ expression: [node] }) as never, {} as never),
    );
    expect(source).toContain("raw(");
    expect(source).not.toContain('cmp(');
    // …while the same operator in a db.query `where` still decodes to cmp():
    // that surface is compiled by the database, which does implement it.
    const queryCtx = new DecodeContext();
    const querySource = printExpr(
      decodeStatement(
        queryCtx,
        new RefIndex(),
        encodeStatement(
          s.db.query({ table: null, where: cmp(col("a"), "in", c.text("[1,2]")), as: "rows" }),
        ) as never,
        {} as never,
      ),
    );
    expect(querySource).toContain("cmp(");
    expect(querySource).toContain('"in"');
    expect(querySource).not.toContain("raw(");
  });

  it("never empties a condition it cannot spell uniformly", () => {
    // The load-bearing negative for the empty-condition rule above: a MIXED
    // `a AND b OR c` container must come back as the explicit `mixed(...)`,
    // never as an empty `when` — emptying it would silently drop a real
    // condition and change which rows the branch takes.
    const node = (or: boolean) => ({
      or,
      type: "statement",
      group: { expression: [] },
      statement: { op: "=", left: { tag: "var", operand: "a", filters: [] }, right: { tag: "const", operand: "1", filters: [] } },
    });
    const ctx = new DecodeContext();
    const source = printExpr(
      decodeStatement(
        ctx,
        new RefIndex(),
        conditional({ expression: [node(false), node(false), node(true)] }) as never,
        {} as never,
      ),
    );
    expect(source).toContain("mixed(");
    expect(source).not.toContain("when: []");
    expect(
      ctx.report.entries.some((e) => e.category === "ambiguous-condition"),
    ).toBe(true);
  });

  it("explains a leading `or` flag, which joins to nothing", () => {
    const node = (or: boolean) => ({
      or,
      type: "statement",
      group: { expression: [] },
      statement: { op: "=", left: { tag: "var", operand: "a", filters: [] }, right: { tag: "const", operand: "1", filters: [] } },
    });
    const ctx = new DecodeContext();
    const source = printExpr(
      decodeStatement(ctx, new RefIndex(), conditional({ expression: [node(true)] }) as never, {} as never),
    );
    expect(source).toContain("raw(");
    expect(ctx.report.entries.find((e) => e.category === "raw-fallback")?.detail).toContain(
      "joins it to nothing",
    );
  });

  it("clears a pending decline note as soon as anything decodes", () => {
    // The contract that makes the note safe. A decline is an upper bound — a
    // later arm may still prove — so a reason left lying around would be
    // attached to some unrelated statement further down the stack and read as
    // fact. Set one by hand, decode something that SUCCEEDS, then fall back on a
    // statement nothing models: the borrowed reason must be gone.
    const ctx = new DecodeContext();
    ctx.declined("a reason from an arm that lost");
    const ok = printExpr(
      decodeStatement(ctx, new RefIndex(), conditional({ expression: [] }) as never, {} as never),
    );
    expect(ok).not.toContain("raw(");

    // A MODELLED statement whose own decline sets no note — so the only way a
    // reason could appear on it is by leaking from before.
    decodeStatement(ctx, new RefIndex(), { name: "mvp:dbo_view", context: {} } as never, {} as never);
    const detail = ctx.report.entries.find((e) => e.category === "raw-fallback")?.detail ?? "";
    expect(detail).toContain("could not reproduce");
    expect(detail).not.toContain("an arm that lost");
  });
});

/**
 * An input binding the engine SKIPS (`ignore: true`).
 *
 * The engine records `"<name>:ignore"` and never binds the value, so the
 * parameter falls back to its declared default — not the same as passing an
 * empty value, and not the same as omitting the entry, which is still stored
 * with its remembered value. 1,766 real entries carry the flag.
 *
 * The db row-write family already modelled it on a `data:` cell; spec-routed
 * statements had nowhere to put it, so their bindings came back as ordinary
 * ones and the statement degraded to `raw()`.
 */
describe("an ignored input binding", () => {
  /** A REAL api_request envelope, with one binding's flag flipped. */
  const stored = (ignore: boolean) => {
    const st = encodeStatement(
      s.api.request({ url: c.text("https://x.test"), params: c.obj({}) } as never),
    ) as unknown as { input: Array<Record<string, unknown>> };
    st.input.find((i) => i.name === "params")!.ignore = ignore;
    return st;
  };

  it("recovers the flag instead of dropping the statement to raw()", () => {
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, new RefIndex(), stored(true) as never, {} as never));
    expect(source).not.toContain("raw(");
    expect(source).toContain("ignored(");
  });

  it("says nothing for an ordinary binding", () => {
    const ctx = new DecodeContext();
    const source = printExpr(decodeStatement(ctx, new RefIndex(), stored(false) as never, {} as never));
    expect(source).not.toContain("ignored(");
  });

  it("round-trips the flag back to the stored bytes", () => {
    const marked = ignored(c.obj({}));
    const entry = encodeStatement(
      s.api.request({ url: c.text("https://x.test"), params: marked } as never),
    ) as unknown as { input: Array<Record<string, unknown>> };
    const params = entry.input.find((i) => i.name === "params")!;
    expect(params.ignore).toBe(true);
    // The value itself is untouched — the marker never reaches the bytes.
    expect(params.tag).toBe("const:obj");
    expect(Object.keys(params)).not.toContain("__ignored");
  });
});

/**
 * Every `raw()` fallback names a CAUSE.
 *
 * Sessions of sweep triage kept re-deriving the same thing: 19 of 31 fallback
 * rows in a 177-project replay said only "could not reproduce the stored
 * statement", and the reason was already known at the point of decline — a
 * guard's label, or the key paths a re-encode disagreed on. Both were written
 * exclusively to `SIDESTEP_PROVE_DIFF`, maintainer instrumentation nobody
 * pulling a workspace has switched on.
 *
 * So the reason reaches the report itself. The guard labels double as the
 * explanation (they already name the surface and what it refused), and a byte
 * mismatch quotes the paths where the bytes actually disagree.
 */
describe("a fallback explains itself without instrumentation", () => {
  /** With the maintainer dump explicitly OFF — the report must not depend on it. */
  function detailWithoutDump(stored: Record<string, unknown>): string {
    const previous = process.env["SIDESTEP_PROVE_DIFF"];
    delete process.env["SIDESTEP_PROVE_DIFF"];
    try {
      return fallbackDetail(stored);
    } finally {
      if (previous !== undefined) process.env["SIDESTEP_PROVE_DIFF"] = previous;
    }
  }

  it("carries a guard's label through as the reason", () => {
    // `update_var` guards on its context being a tagged value; this one is not.
    const detail = detailWithoutDump({
      name: "mvp:update_var",
      context: { nothing: "tagged here" },
    });
    expect(detail).toContain("could not reproduce");
    expect(detail).toContain("update_var");
    // The guard's own words, not a generic "could not reproduce".
    expect(detail).toContain("not a tagged value");
  });

  it("names the key path a re-encode disagreed on", () => {
    // A REAL statement the decoder handles, plus one key no authoring surface
    // writes. The decode must fail — and say which key did it.
    const stored = encodeStatement(
      s.api.request({ url: c.text("https://x.test") } as never),
    ) as unknown as Record<string, unknown>;
    (stored["context"] as Record<string, unknown>)["not_a_modelled_key"] = true;

    const detail = detailWithoutDump(stored);
    expect(detail).toContain("disagrees with the stored bytes");
    expect(detail).toContain("not_a_modelled_key");
  });

  it("keeps the most specific reason when a coarser guard follows it", () => {
    // First writer wins. The condition decliner runs deepest and knows exactly
    // what it refused; its statement's guard then reports the same failure in
    // the vaguest available terms. Losing the first to the second is the whole
    // bug this ordering exists to prevent.
    const detail = detailWithoutDump({
      name: "mvp:conditional",
      context: {
        expr: {
          expression: [
            {
              or: true,
              type: "statement",
              group: { expression: [] },
              statement: {
                op: "=",
                left: { tag: "var", operand: "a", filters: [] },
                right: { tag: "const", operand: "1", filters: [] },
              },
            },
          ],
        },
        if: { run: [] },
        elif: { run: [] },
        else: { run: [] },
      },
    });
    expect(detail).toContain("joins it to nothing");
    expect(detail).not.toContain("is not a decodable condition");
  });
});

describe("an `ignore` flag on an entry that is not row data", () => {
  it("names itself instead of surfacing as an anonymous byte difference", () => {
    // `ignore` is honoured on EVERY input entry, not just row data: the engine
    // walks a statement's `input[]` through one generic routine that records a
    // flagged entry as `"<name>:ignore"` and then skips it, so it never reaches
    // the statement and never joins the input whitelist. On a lookup that means
    // the row is never found by `field_name` at all.
    //
    // The SDK has no authoring surface for that, and should not grow one — so
    // `raw()` is right, and the only defect was that the decline said nothing.
    // It reported two anonymous `.input[].ignore` byte diffs and left a
    // maintainer to work out which entry and why.
    const detail = fallbackDetail({
      name: "mvp:dbo_editby",
      context: { dbo: { id: deriveGuid("dbo", "post") } },
      input: [
        { name: "field_name", tag: "const", value: "id", filters: [], ignore: true },
        { name: "field_value", tag: "var", value: "x", filters: [] },
      ],
    });
    expect(detail).toContain("field_name");
    expect(detail).toContain("ignore");
    expect(detail).toContain("only row data can hold");
  });
});

describe("the declines that are meant to stay", () => {
  // A triage pass relaxed the preconditions that were stricter than the engine
  // (`db.query`'s external/paging pair, `f.enum`'s non-empty values). These four
  // are the ones deliberately left standing, and each is left standing for its
  // own reason — so they are pinned by the message that states it. A future
  // relaxation should be a decision someone made, not a test quietly going green.
  const STAYS: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [
      // The engine drops a flagged entry before the statement sees it, so
      // authoring this would let a user write something silently discarded.
      "db.edit with `ignore` on field_name",
      {
        name: "mvp:dbo_editby",
        context: { dbo: { id: deriveGuid("dbo", "post") } },
        input: [
          { name: "field_name", tag: "const", value: "id", filters: [], ignore: true },
          { name: "field_value", tag: "var", value: "x", filters: [] },
        ],
      },
      "only row data can hold",
    ],
    [
      "db.patch with no `item` entry",
      {
        name: "mvp:dbo_patch",
        context: { dbo: { id: deriveGuid("dbo", "post") } },
        input: [
          { name: "field_name", tag: "const", value: "id", filters: [] },
          { name: "field_value", tag: "var", value: "x", filters: [] },
        ],
      },
      'input[] is missing required "item"',
    ],
    [
      "db.get whose input[] leads with the wrong entry",
      {
        name: "mvp:dbo_getby",
        context: { dbo: { id: deriveGuid("dbo", "post") } },
        input: [
          { name: "field_value", tag: "var", value: "x", filters: [] },
          { name: "field_name", tag: "const", value: "id", filters: [] },
        ],
      },
      "does not lead with field_name/field_value",
    ],
    [
      // A leading `or` joins to nothing. Unlike the `external`/`paging` pair,
      // there is no engine behaviour being misdescribed here — the stored form
      // genuinely has no authored spelling.
      "a condition whose first sibling carries an `or` flag",
      {
        name: "mvp:dbo_view",
        context: {
          dbo: { id: deriveGuid("dbo", "post") },
          search: {
            expression: [
              {
                or: true,
                type: "statement",
                group: { expression: [] },
                statement: {
                  op: "=",
                  left: { tag: "col", filters: [], operand: "post.id" },
                  right: { tag: "const:int", filters: [], operand: "1" },
                },
              },
            ],
          },
        },
      },
      "joins it to nothing",
    ],
    [
      "action.package.call carrying a marketplace identity",
      { name: "mvp:action_package", context: { market_item: { id: 5, guid: "g", version: 1 } } },
      "marketplace identity",
    ],
  ];

  it.each(STAYS)("declines %s, and names why", (_label, stored, because) => {
    const detail = fallbackDetail(stored);
    expect(detail).toContain(because);
    // Still a warning, not quietly downgraded to one of the new notices.
    expect(detail).toContain("could not reproduce the stored statement");
  });
});

describe("an async call's runtime block decodes instead of falling back", () => {
  /** Decode one stored statement and print the expression it produced. */
  function decoded(stored: Record<string, unknown>): string {
    const ctx = new DecodeContext();
    const refs = RefIndex.fromPayload(
      { function: [{ name: "worker", guid: deriveGuid("function", "worker") }] },
      ctx,
    );
    return printExpr(decodeStatement(ctx, refs, stored as never, {} as never));
  }

  it("recovers the editor's async-shared spelling, blank resources and all", () => {
    // The one shape in the 177-project corpus that carried a real `runtime`. It
    // cost the whole statement to `raw()` because nothing modelled the block.
    const source = decoded({
      name: "mvp:function",
      context: { function: { id: deriveGuid("function", "worker") } },
      input: [],
      runtime: { cpu: "", mode: "async-shared", memory: "", timeout: "", max_retry: "" },
    });
    expect(source).toContain("function.run");
    expect(source).toContain("async-shared");
    expect(source).not.toContain("raw(");
    // The inert resources are NOT carried across — the engine does not read them
    // at this mode, so authoring them back would claim more than the statement does.
    expect(source).not.toContain("cpu");
  });

  it("carries the dedicated resources, which that mode DOES read", () => {
    const source = decoded({
      name: "mvp:function",
      context: { function: { id: deriveGuid("function", "worker") } },
      input: [],
      runtime: { mode: "async-dedicated", cpu: "250m", memory: "512Mi", timeout: "300", max_retry: "2" },
    });
    expect(source).toContain("async-dedicated");
    expect(source).toContain("250m");
    expect(source).toContain("maxRetry");
    expect(source).not.toContain("raw(");
  });

  it("says nothing about a synchronous call, in every stored spelling", () => {
    // Three spellings of "not async": the absent key, the `null` one engine
    // generation writes, and the explicit `"disabled"` the settings panel writes
    // when the user picks "Standard run (Synchronous)" — with the dedicated
    // inputs left behind blank, as that form does.
    const spellings: Array<Record<string, unknown>> = [
      {},
      { runtime: null },
      { runtime: { mode: "disabled", cpu: "", memory: "", timeout: "", max_retry: "" } },
    ];
    for (const spelling of spellings) {
      const source = decoded({
        name: "mvp:function",
        context: { function: { id: deriveGuid("function", "worker") } },
        input: [],
        ...spelling,
      });
      expect(source).not.toContain("runtime");
      expect(source).not.toContain("raw(");
    }
  });
});
