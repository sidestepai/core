import { describe, it, expect, expectTypeOf } from "vitest";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import {
  dbGet,
  dbQuery,
  dbAdd,
  dbEdit,
  dbDel,
  dbPatch,
  dbAddOrEdit,
  dbHas,
  dbBulkPatch,
  dbBulkDelete,
} from "../../src/statements/special/db.js";
import { c } from "../../src/values/value.js";
import { encodeStatement } from "../../src/statements/statement.js";
import type { Statement } from "../../src/statements/statement.js";
import type { InferRow } from "../../src/kinds/table.js";

/**
 * U4 (issue #5) — `db.get`/`db.query` brand their return with the stack variable
 * they bind (`__as`) and the row shape they produce (`__shape`), the type-level
 * raw material `InferResponse`'s single-variable trace (U5) reads. The brands are
 * phantom: the runtime statement is unchanged (guarded by encode assertions).
 */

const user = table({
  name: "user",
  schema: {
    username: f.text({ required: true }),
    email: f.email(),
  },
});

describe("db read statement brands (type-level)", () => {
  it("db.get captures `as` and the full row shape `| null` (null-on-miss, #105)", () => {
    const stmt = dbGet({ table: user, fieldValue: c.int(1), as: "u" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"u">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user> | null>();
  });

  it("db.get narrows a dotted sub-key selection by its ROOT column", () => {
    // A dotted path selects sub-keys of an object column. Narrowing by the whole
    // path would `Pick` a key that does not exist and drop the column from the
    // response shape entirely — the selection would type as `{}`.
    const stmt = dbGet({
      table: user,
      fieldValue: c.int(1),
      output: ["id", "email.verified"],
      as: "u",
    });
    expectTypeOf(stmt.__shape).toEqualTypeOf<Pick<InferRow<typeof user>, "id" | "email"> | null>();
  });

  it("db.get with an `output` selection narrows the row shape to those columns `| null` (#105)", () => {
    const stmt = dbGet({ table: user, fieldValue: c.int(1), output: ["id", "username"], as: "u" });
    expectTypeOf(stmt.__shape).toEqualTypeOf<Pick<InferRow<typeof user>, "id" | "username"> | null>();
  });

  it("db.query captures `as` and produces a row LIST shape", () => {
    const stmt = dbQuery({ table: user, as: "rows" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"rows">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>[]>();
  });

  it("db.add captures `as` and the full inserted-row shape", () => {
    const stmt = dbAdd({ table: user, row: { username: c.text("a") }, as: "created" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"created">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>>();
  });

  it("db.edit captures `as` and the full post-mutation row shape", () => {
    const stmt = dbEdit({ table: user, fieldValue: c.int(1), row: { username: c.text("a") }, as: "updated" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"updated">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>>();
  });

  it("db.del is intentionally unbranded — it binds `null`, not the deleted row", () => {
    const stmt = dbDel({ table: user, fieldValue: c.int(1), as: "removed" });
    const asStatement: Statement = stmt;
    void asStatement;
    // Unbranded: the engine's `dbo_delby` declares no output schema and returns
    // nothing, so a returned del var infers `unknown` (see infer.test.ts).
    // @ts-expect-error `__shape` is not present on the plain Statement dbDel returns.
    void stmt.__shape;
  });

  it("db.patch captures `as` and the full post-patch row shape", () => {
    const stmt = dbPatch({ table: user, fieldValue: c.int(1), data: c.obj({}), as: "patched" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"patched">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>>();
  });

  it("db.add_or_edit captures `as` and the full upserted row shape", () => {
    const stmt = dbAddOrEdit({ table: user, fieldValue: c.int(1), row: { username: c.text("a") }, as: "upserted" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"upserted">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>>();
  });

  it("db.has captures `as` and a boolean shape (table-independent)", () => {
    const stmt = dbHas({ table: user, fieldValue: c.int(1), as: "exists" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"exists">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<boolean>();
  });

  it("db.bulk.patch captures `as` and a row LIST shape", () => {
    const stmt = dbBulkPatch({ table: user, items: c.array([]), as: "patched" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"patched">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>[]>();
  });

  it("db.bulk.delete captures `as` and a number (count) shape", () => {
    const stmt = dbBulkDelete({ table: user, as: "removed" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"removed">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<number>();
  });

  it("a bare-name table yields an `unknown` shape (nothing to infer)", () => {
    const stmt = dbGet({ table: "user", fieldValue: c.int(1), as: "u" });
    expectTypeOf(stmt.__shape).toEqualTypeOf<unknown>();
    // Row-binding writes against a bare-name table are equally unbranded.
    expectTypeOf(dbAdd({ table: "user", data: [], as: "d" }).__shape).toEqualTypeOf<unknown>();
  });

  it("write brands are phantom — the encoded statement is unchanged", () => {
    const stmt = dbAdd({ table: user, row: { username: c.text("a") }, as: "created" });
    const asStatement: Statement = stmt;
    void asStatement;
    const xdo = encodeStatement(stmt) as unknown as Record<string, unknown>;
    expect("__as" in xdo).toBe(false);
    expect("__shape" in xdo).toBe(false);
    expect(xdo.name).toBe("mvp:dbo_add");
    expect(xdo.as).toBe("created");
  });

  it("add_or_edit brand is phantom — its hand-built literal encodes unchanged", () => {
    const stmt = dbAddOrEdit({ table: user, fieldValue: c.int(1), row: { username: c.text("a") }, as: "upserted" });
    const xdo = encodeStatement(stmt) as unknown as Record<string, unknown>;
    expect("__as" in xdo).toBe(false);
    expect("__shape" in xdo).toBe(false);
    expect(xdo.name).toBe("mvp:dbo_addoreditby");
    expect(xdo.as).toBe("upserted");
  });

  it("bulk.delete brand is phantom — its double-cast literal encodes unchanged", () => {
    const stmt = dbBulkDelete({ table: user, as: "removed" });
    const xdo = encodeStatement(stmt) as unknown as Record<string, unknown>;
    expect("__as" in xdo).toBe(false);
    expect("__shape" in xdo).toBe(false);
    expect(xdo.name).toBe("mvp:dbo_bulkdelete");
    expect(xdo.as).toBe("removed");
  });

  it("a branded statement is still a plain Statement and encodes unchanged", () => {
    const stmt = dbGet({ table: user, fieldValue: c.int(1), as: "u" });
    const asStatement: Statement = stmt;
    void asStatement;
    const xdo = encodeStatement(stmt) as unknown as Record<string, unknown>;
    // No phantom carriers leak into the encoded form.
    expect("__as" in xdo).toBe(false);
    expect("__shape" in xdo).toBe(false);
    expect(xdo.name).toBe("mvp:dbo_getby");
    expect(xdo.as).toBe("u");
  });
});
