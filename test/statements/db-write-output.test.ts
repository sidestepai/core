/**
 * `output` on the row WRITES — `db.add`, `db.edit`, `db.patch`.
 *
 * The editor offers column selection on every CRUD statement whose result is a
 * row; it hides the control only when a statement's whole output is a single
 * `bool`/`int` scalar, which is why `db.del` (count) and `db.has` (bool) take no
 * `output`, and why `db.add_or_edit` takes none either — it writes only the
 * uncustomized envelope in its leaner serialization.
 *
 * The selection restricts the CONFIRMATION RESPONSE only. It does not change
 * what is written, which is the one thing a reader could plausibly get wrong.
 *
 * Two real `db.add` statements in a 177-workspace sweep stored a selection and
 * fell back to `raw()` for want of a surface to decode into.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import { dbAdd, dbEdit, dbPatch, dbAddOrEdit, dbDel } from "../../src/statements/special/db.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { printExpr } from "../../src/codegen/print.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { c } from "../../src/values/value.js";
import type { StackItemXdo } from "../../src/types/xdo.js";

const post = table({
  name: "post",
  schema: { title: f.text(), body: f.text(), secret: f.text() },
});

const REFS = RefIndex.fromPayload(
  { dbo: [{ name: post.name, guid: deriveGuid("dbo", post.name) }] },
  new DecodeContext(),
);

function envelope(stmt: unknown): unknown {
  return (stmt as { output?: unknown }).output;
}

function decode(stored: unknown): { source: string; ctx: DecodeContext } {
  const ctx = new DecodeContext();
  return { source: printExpr(decodeStatement(ctx, REFS, stored as StackItemXdo, {})), ctx };
}

describe("a row write's `output` column selection", () => {
  const cases = [
    ["db.add", () => dbAdd({ table: post, row: { title: c.text("hi") }, output: ["id", "title"] })],
    [
      "db.edit",
      () =>
        dbEdit({
          table: post,
          fieldValue: c.int(1),
          row: { title: c.text("hi") },
          output: ["id", "title"],
        }),
    ],
    [
      "db.patch",
      () => dbPatch({ table: post, fieldValue: c.int(1), data: c.obj({}), output: ["id", "title"] }),
    ],
  ] as const;

  for (const [name, build] of cases) {
    it(`${name} emits the customized envelope`, () => {
      expect(envelope(encodeStatement(build()))).toEqual({
        customize: true,
        filters: [],
        items: [
          { name: "id", children: [] },
          { name: "title", children: [] },
        ],
      });
    });

    it(`${name} round-trips the selection back to a readable call`, () => {
      const stored = encodeStatement(build());
      const { source, ctx } = decode(stored);
      expect(source).toMatch(/output: \[\s*"id",\s*"title",?\s*\]/);
      expect(source).not.toContain("raw(");
      expect(ctx.report.entries.some((e) => e.category === "raw-fallback")).toBe(false);
    });

    it(`${name} without a selection keeps the uncustomized envelope`, () => {
      // The paired negative — the common case must not move.
      const bare = encodeStatement(
        name === "db.add"
          ? dbAdd({ table: post, row: { title: c.text("hi") } })
          : name === "db.edit"
            ? dbEdit({ table: post, fieldValue: c.int(1), row: { title: c.text("hi") } })
            : dbPatch({ table: post, fieldValue: c.int(1), data: c.obj({}) }),
      );
      expect(envelope(bare)).toMatchObject({ customize: false, items: [] });
    });
  }

  it("does not change what is written — only what comes back", () => {
    // The misreading worth guarding: a narrow `output` must not narrow the row.
    const selective = encodeStatement(
      dbAdd({ table: post, row: { title: c.text("hi"), body: c.text("b") }, output: ["id"] }),
    ) as unknown as { input: Array<{ name: string }> };
    const full = encodeStatement(
      dbAdd({ table: post, row: { title: c.text("hi"), body: c.text("b") } }),
    ) as unknown as { input: Array<{ name: string }> };
    expect(selective.input.map((e) => e.name)).toEqual(full.input.map((e) => e.name));
  });

  it("is not offered where the editor hides it", () => {
    // `db.del` binds a count and `db.add_or_edit` never carries a customized
    // envelope, so neither grows an `output` arg. Asserted on the emitted bytes,
    // since a type-level absence is not observable at runtime.
    expect(envelope(encodeStatement(dbDel({ table: post, fieldValue: c.int(1) })))).toMatchObject({
      customize: false,
    });
    expect(
      envelope(encodeStatement(dbAddOrEdit({ table: post, fieldValue: c.int(1), row: { title: c.text("x") } }))),
    ).toMatchObject({ customize: false });
  });
});
