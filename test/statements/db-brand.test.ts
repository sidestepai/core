import { describe, it, expect, expectTypeOf } from "vitest";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { dbGet, dbQuery } from "../../src/statements/special/db.js";
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

  it("a bare-name table yields an `unknown` shape (nothing to infer)", () => {
    const stmt = dbGet({ table: "user", fieldValue: c.int(1), as: "u" });
    expectTypeOf(stmt.__shape).toEqualTypeOf<unknown>();
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
