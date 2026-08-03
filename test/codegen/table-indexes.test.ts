/**
 * Table decode — the system columns and indexes nobody authored.
 *
 * A decoded table carries a COMPLETE schema and index list, so the encoder's
 * auto-injection has to be kept out of the way. `system: false` does that
 * bluntly, and cost every generated table the three standard index literals: a
 * `primary(id)`, a `btree(created_at desc)`, and (in xdo storage) a
 * `gin(xdo jsonb_path_op)`, none of which a user ever wrote.
 *
 * The quiet form drops them and lets the injection put them back. That is only
 * safe when it round-trips, so the claims here are paired: what the emitted text
 * says, and — through the corpus and golden suites — that the same object still
 * re-encodes equal. The refusals matter as much: a table whose stored set is
 * reordered, partial, or missing its system columns keeps the verbose form.
 *
 * Which SUBSET gets dropped is the proof's answer, not a fixed rule — the engine
 * has shipped more than one canonical order, and leaving one entry stated is what
 * lets the other two go on a table the all-or-nothing form gave up on entirely.
 */
import { describe, it, expect } from "vitest";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { printExpr } from "../../src/codegen/print.js";
import { decodeObject, KIND_DECODERS_BY_NAME } from "../../src/codegen/kinds/index.js";
import { elideSystemIndexes } from "../../src/kinds/table.js";
import { loadFixture } from "../conformance/harness.js";
import "../../src/index.js"; // register kinds

/** Decode ONE stored table with no bundle around it. */
function decodeTable(stored: Record<string, unknown>): string {
  const ctx = new DecodeContext();
  const refs = RefIndex.fromPayload({}, ctx);
  const decoder = KIND_DECODERS_BY_NAME.get("table")!;
  return printExpr(decodeObject(decoder, { ctx, refs, stored, resolve: {} }).expr);
}

/**
 * Just the emitted `index:` argument.
 *
 * Asserted against rather than the whole def because a column named
 * `created_at` puts that string in the SCHEMA too, so a bare `not.toContain`
 * would pass or fail for the wrong reason.
 */
function indexArg(source: string): string {
  const start = source.indexOf("\n  index: [");
  if (start === -1) return "";
  const end = source.indexOf("\n  ],", start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** A stored index entry in the engine's own spelling. */
function index(type: string, field: string, op = ""): Record<string, unknown> {
  return {
    lang: "",
    name: "",
    type,
    fields: [{ op, name: field }],
    market_item: { id: 0, guid: "", version: 0 },
  };
}

const PRIMARY = index("primary", "id");
const CREATED = index("btree", "created_at", "desc");
const GIN = index("gin", "xdo", "jsonb_path_op");
const SKU = index("btree|unique", "sku");

/** A stored table carrying the system columns and whatever indexes are given. */
function storedTable(indexes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    name: "t",
    guid: "test-guid-table",
    schema: [
      { name: "id", type: "int", required: true },
      { name: "created_at", type: "epochms", default: "now", access: "private" },
      { name: "sku", type: "text" },
    ],
    index: indexes,
    ...extra,
  };
}

describe("table decode — standard indexes", () => {
  it("drops the standard set and the `system` key on a real engine table", () => {
    // `ex_kind_products.json` is engine-persisted: `primary(id)` and
    // `btree(created_at desc)` ahead of two the user actually created.
    const src = decodeTable(loadFixture<Record<string, unknown>>("tables/ex_kind_products.json"));
    expect(src).not.toContain("system:");
    expect(indexArg(src)).not.toContain('type: "primary"');
    expect(indexArg(src)).not.toContain('name: "created_at"');
    // The authored ones stay, verbatim and in order.
    expect(indexArg(src)).toContain('type: "btree|unique"');
    expect(indexArg(src)).toContain('name: "sku"');
    expect(indexArg(src)).toContain('name: "price"');
  });

  it("emits no `index` key at all when every index was a standard one", () => {
    const src = decodeTable(storedTable([PRIMARY, CREATED]));
    expect(src).not.toContain("system:");
    expect(src).not.toContain("index:");
  });

  it("reads the gin index as xdo storage when the stored flag predates it", () => {
    // Real pulled workspaces carry the gin index with no `use_xdo` at all.
    // Reading that absence as `false` writes a table claiming column storage
    // while carrying the index only JSON storage produces.
    const src = decodeTable(storedTable([PRIMARY, GIN, CREATED]));
    expect(src).toContain("useXdo: true");
    expect(src).not.toContain("system:");
    expect(src).not.toContain("index:");
  });

  it("elides around an older canonical order rather than giving up on it", () => {
    // The engine has shipped both `primary, gin, created_at` (what the injection
    // writes) and `primary, created_at, gin` — 223 tables on the survey instance
    // are the second. Dropping all three would reorder them; dropping the two
    // that lead and leaving the `gin` stated reproduces the list exactly.
    const src = decodeTable(storedTable([PRIMARY, CREATED, GIN, SKU]));
    expect(src).toContain("useXdo: true");
    expect(src).not.toContain("system:");
    // Both leading entries go; the `gin` stays stated because it is what holds
    // the stored order together, and the authored index rides behind it.
    expect(indexArg(src)).not.toContain('type: "primary"');
    expect(indexArg(src)).not.toContain('op: "desc"');
    expect(indexArg(src)).toContain('type: "gin"');
    expect(indexArg(src)).toContain('type: "btree|unique"');
  });

  it("believes an explicitly stored `use_xdo: false` over the gin index", () => {
    const src = decodeTable(storedTable([PRIMARY, GIN, CREATED], { use_xdo: false }));
    expect(src).not.toContain("useXdo:");
    // Column storage means the injection is `primary, created_at` — it would not
    // put the gin index back, and it cannot reach past it to the `created_at`
    // that trails it. So only the leading `primary` is elided and the rest is
    // stated, which is still quieter than suppressing the injection wholesale.
    expect(src).not.toContain("system:");
    expect(indexArg(src)).not.toContain('type: "primary"');
    expect(indexArg(src)).toContain('type: "gin"');
    expect(indexArg(src)).toContain('op: "desc"');
  });

  it("keeps the verbose form when the stored set is missing a standard index", () => {
    // The injection would ADD `primary(id)`, which the source does not have.
    const src = decodeTable(storedTable([CREATED, SKU]));
    expect(src).toContain("system: false");
    expect(indexArg(src)).toContain('type: "btree|unique"');
  });

  it("keeps the verbose form when the stored set is reordered", () => {
    const src = decodeTable(storedTable([SKU, PRIMARY, CREATED]));
    expect(src).toContain("system: false");
    expect(indexArg(src)).toContain('type: "primary"');
  });

  it("keeps the verbose form when the schema omits a system column", () => {
    // `system: true` would inject the missing COLUMN as well as the indexes.
    const stored = {
      ...storedTable([PRIMARY, CREATED]),
      schema: [{ name: "id", type: "int", required: true }, { name: "sku", type: "text" }],
    };
    const src = decodeTable(stored);
    expect(src).toContain("system: false");
    expect(indexArg(src)).toContain('type: "primary"');
  });
});

describe("elideSystemIndexes", () => {
  it("declines rather than guessing when the result would not re-encode", () => {
    expect(elideSystemIndexes([{ type: "btree", fields: [{ name: "sku" }] }], false)).toBeNull();
  });

  it("keeps a same-signature index the author declared with a name", () => {
    // Dedup matches on type + covered fields, so a NAMED `primary(id)` would be
    // dropped and put back unnamed. The encoded comparison catches that.
    expect(
      elideSystemIndexes(
        [
          { type: "primary", fields: [{ name: "id" }], name: "products_pkey" },
          { type: "btree", fields: [{ name: "created_at", op: "desc" }] },
        ],
        false,
      ),
    ).toBeNull();
  });
});
