import { describe, it, expect, expectTypeOf } from "vitest";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { dbGet, dbQuery, dbAdd, dbEdit, dbDel } from "../../src/statements/special/db.js";
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
  it("db.get captures `as` and the full row shape", () => {
    const stmt = dbGet({ table: user, fieldValue: c.int(1), as: "u" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"u">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>>();
  });

  it("db.get with an `output` selection narrows the row shape to those columns", () => {
    const stmt = dbGet({ table: user, fieldValue: c.int(1), output: ["id", "username"], as: "u" });
    expectTypeOf(stmt.__shape).toEqualTypeOf<Pick<InferRow<typeof user>, "id" | "username">>();
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

  it("db.del captures `as` and the full deleted-row shape", () => {
    const stmt = dbDel({ table: user, fieldValue: c.int(1), as: "removed" });
    expectTypeOf(stmt.__as).toEqualTypeOf<"removed">();
    expectTypeOf(stmt.__shape).toEqualTypeOf<InferRow<typeof user>>();
  });

  it("a bare-name table yields an `unknown` shape (nothing to infer)", () => {
    const stmt = dbGet({ table: "user", fieldValue: c.int(1), as: "u" });
    expectTypeOf(stmt.__shape).toEqualTypeOf<unknown>();
    // Writes against a bare-name table are equally unbranded.
    expectTypeOf(dbDel({ table: "user", fieldValue: c.int(1), as: "d" }).__shape).toEqualTypeOf<unknown>();
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
