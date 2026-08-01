/**
 * A `db.query`'s dead `context.return` branches.
 *
 * The return section declares one sub-block per return type — `single`, `list`,
 * `stream`, `aggregate` — and `return.type` selects which one runs. The editor's
 * return panel is a single form group over that whole section and emits
 * `form.value` on save, so it writes ALL of them: a query that returns `single`
 * still stores a fully-populated `list` block, and a query that was a paged list
 * before its type was switched keeps that paging forever.
 *
 * Nothing reads the off-branches. The converter that turns the stored section
 * into the engine's query config is a chain of `if (returnType == "…")` arms,
 * each touching only `return.<that type>.*`; Xano's own XanoScript↔stack
 * translator writes only the live block. So they are dropped — the same editor
 * exhaust as an expression group's `statement` branch, and dropped on the same
 * rule: never discard what someone MEANT, not never discard bytes.
 *
 * Reading them as authored is what made 14 `db.query` statements in a
 * 177-workspace sweep fall back to `raw()` — every one of them decodable.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register kinds + statements
import { dbQuery, type DbAggregate } from "../../src/statements/special/db.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { printExpr } from "../../src/codegen/print.js";
import { normalize } from "../../src/validate/normalize.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { deriveGuid } from "../../src/refs/guid.js";
import type { StackItemXdo } from "../../src/types/xdo.js";

const post = table({
  name: "post",
  schema: { author_id: f.int(), title: f.text() },
});

/** Decode one stored statement against a ref index that knows `post`. */
function decode(stored: StackItemXdo): { source: string; ctx: DecodeContext } {
  const ctx = new DecodeContext();
  const refs = RefIndex.fromPayload({ dbo: [{ name: post.name, guid: deriveGuid("dbo", post.name) }] }, ctx);
  return { source: printExpr(decodeStatement(ctx, refs, stored, {})), ctx };
}

/** A stored `dbo_view` built from real authoring args, with extra return branches grafted on. */
function withDeadBranches(
  args: Parameters<typeof dbQuery>[0],
  dead: Record<string, unknown>,
): StackItemXdo {
  const stored = encodeStatement(dbQuery(args)) as unknown as {
    context: { return?: Record<string, unknown> };
  };
  stored.context.return = { ...(stored.context.return ?? {}), ...dead };
  return stored as unknown as StackItemXdo;
}

describe("a db.query's dead return branches", () => {
  it("decodes a `single` query that still stores a configured `list` block", () => {
    const stored = withDeadBranches(
      { table: post, returnType: "single", as: "row" },
      {
        list: {
          sort: [{ sortBy: "post.created_at", orderBy: "desc" }],
          paging: { page: 1, offset: 0, per_page: 10, enabled: true, metadata: true, totals: false },
          distinct: "auto",
        },
      },
    );
    const { source, ctx } = decode(stored);
    // Readable, not carried verbatim — the whole point.
    expect(source).toContain("s.db.query");
    expect(source).not.toContain("raw(");
    expect(ctx.report.entries.some((e) => e.category === "raw-fallback")).toBe(false);
    // The dead block held a real sort and real paging, so the discard is SAID.
    const omission = ctx.report.entries.find((e) => e.category === "expected-omission");
    expect(omission?.detail).toContain('"list" return block');
    expect(omission?.detail).toContain("inert");
  });

  it("says nothing about a dead branch holding only the editor's defaults", () => {
    // The panel writes these on every save. Reporting them would fire on nearly
    // every query pulled, which is how a report stops being read.
    const stored = withDeadBranches(
      { table: post, returnType: "single", as: "row" },
      {
        list: {
          sort: [],
          paging: { page: 1, offset: 0, per_page: 25, enabled: false, metadata: true, totals: false },
          distinct: "auto",
        },
        stream: { sort: [], paging: { page: 1, per_page: 25, enabled: false }, distinct: "auto" },
        aggregate: {
          eval: [],
          sort: [],
          group: [],
          index: [],
          paging: { page: 1, per_page: 25, enabled: false, metadata: true },
        },
      },
    );
    const { source, ctx } = decode(stored);
    expect(source).toContain("s.db.query");
    expect(ctx.report.entries.some((e) => e.category === "expected-omission")).toBe(false);
  });

  it("never drops the branch that actually runs", () => {
    // The load-bearing negative. If the live block could be swept up with its
    // siblings, a paged query would decode as unpaged and the generated call
    // would be WRONG rather than merely unreadable.
    const stored = withDeadBranches(
      { table: post, paging: { per_page: 10, totals: true }, as: "rows" },
      { single: { sort: [{ sortBy: "post.id", orderBy: "asc" }] } },
    );
    const { source } = decode(stored);
    expect(source).toContain("per_page: 10");
    expect(source).toContain("totals: true");
  });

  it("compares equal to the same query with no leftover at all", () => {
    // What the drop actually asserts: the editor's shape and the SDK's shape are
    // the same statement.
    const clean = encodeStatement(dbQuery({ table: post, returnType: "single", as: "row" }));
    const grafted = withDeadBranches(
      { table: post, returnType: "single", as: "row" },
      { list: { sort: [{ sortBy: "post.id", orderBy: "desc" }], distinct: "no" } },
    );
    expect(normalize(grafted)).toEqual(normalize(clean));
  });
});

/**
 * An aggregate's paging gate. Every field under `aggregate.paging` is read only
 * when `enabled` is on, so a block left behind with the gate off is configured
 * but inert — a state the editor produces by switching pagination back off, and
 * one the authoring surface could not express until `enabled` was added.
 */
describe("an aggregate's parked paging block", () => {
  const aggregate: DbAggregate = {
    group: [{ name: "author_id", as: "author" }],
    eval: [{ name: "id", as: "n", filters: [{ name: "count" }] }],
  };

  it("round-trips a gate that was switched off", () => {
    const stored = encodeStatement(
      dbQuery({
        table: post,
        returnType: "aggregate",
        aggregate: { ...aggregate, paging: { per_page: 10, enabled: false } },
        as: "rows",
      }),
    ) as unknown as { context: { return: { aggregate: { paging: Record<string, unknown> } } } };
    expect(stored.context.return.aggregate.paging).toMatchObject({ enabled: false, per_page: 10 });

    const { source, ctx } = decode(stored as unknown as StackItemXdo);
    expect(source).toContain("enabled: false");
    expect(ctx.report.entries.some((e) => e.category === "raw-fallback")).toBe(false);
  });

  it("still defaults the gate ON when paging is asked for", () => {
    // Passing `paging` at all is how you request it; `enabled` exists to
    // reproduce the parked state, not to make every author write it.
    const stored = encodeStatement(
      dbQuery({
        table: post,
        returnType: "aggregate",
        aggregate: { ...aggregate, paging: { per_page: 10 } },
        as: "rows",
      }),
    ) as unknown as { context: { return: { aggregate: { paging: Record<string, unknown> } } } };
    expect(stored.context.return.aggregate.paging).toMatchObject({ enabled: true });
  });
});

/**
 * A join whose table was deleted.
 *
 * `context.bind[]` stores `{dbo:{as,id:""}}` — the engine clears the id rather
 * than recording a tombstone, so an unbound join is byte-identical to one that
 * was never bound. `DbBind.table` models that as `null`, on the same contract
 * the query's own `table` and an addon's have held all along.
 *
 * Before that it declined, and a decline on one join took the WHOLE statement to
 * `raw()` — an entire readable query lost to a single broken join.
 */
describe("a db.query join to an unbound table", () => {
  const storedWithBind = (bind: unknown) => {
    const stored = encodeStatement(dbQuery({ table: post })) as unknown as {
      context: Record<string, unknown>;
    };
    stored.context.bind = [bind];
    return stored as unknown as StackItemXdo;
  };

  it("recovers the join as `table: null` instead of losing the statement", () => {
    const { source, ctx } = decode(
      storedWithBind({ dbo: { as: "userJoin", id: "" }, join: "inner", search: { expression: [] } }),
    );
    expect(source).not.toContain("raw(");
    expect(source).toContain("table: null");
    // The alias is authored even though a bound join would default it — an
    // unbound join has no table name to default FROM, and the stored bytes show
    // the user's alias outliving the table.
    expect(source).toContain("userJoin");
    // Reported, not emitted quietly: a lost binding presented as a deliberate
    // `null` would hide a real defect in the pulled workspace.
    expect(ctx.report.entries.some((e) => e.category === "unresolved-ref")).toBe(true);
  });

  it("decodes through `prove`, so the emitted form reproduces the stored bytes", () => {
    // `prove` re-encodes the candidate and compares it to the stored statement;
    // a disagreement is what produces `raw()`. So the absence of a `raw-fallback`
    // entry IS the byte-equality assertion here — including the blank `dbo.id`
    // and the alias that outlived the table.
    const { ctx } = decode(
      storedWithBind({
        dbo: { as: "userJoin", id: "" },
        join: "inner",
        search: { expression: [] },
      }),
    );
    expect(ctx.report.entries.some((e) => e.category === "raw-fallback")).toBe(false);
  });

  it("still resolves a BOUND join, and still defaults its alias", () => {
    const { source, ctx } = decode(
      storedWithBind({ dbo: { as: post.name, id: deriveGuid("dbo", post.name) }, join: "inner" }),
    );
    expect(source).not.toContain("table: null");
    // Alias equals the table name, so it is left to default.
    expect(source).not.toContain(`as: "${post.name}"`);
    expect(ctx.report.entries.some((e) => e.category === "unresolved-ref")).toBe(false);
  });
});
