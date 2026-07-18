/**
 * Schema-aware db typing (Tier 3) — a `table()` authored with a FieldMap schema
 * captures its column names in the returned handle, so db statements that take
 * the table type their column-name fields (`fieldName`, `output`, `sortBy`, and
 * `row` keys) against the real columns. Valid columns compile + emit; unknown
 * columns are a compile-time error (asserted with `@ts-expect-error`). A table
 * referenced by bare name stays loosely typed (any string accepted).
 */
import { describe, it, expect } from "vitest";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { dbGet, dbQuery, dbAdd } from "../../src/statements/special/db.js";
import { c } from "../../src/values/value.js";

const users = table({
  name: "user",
  schema: {
    username: f.text({ methods: ["trim"] }),
    email: f.email(),
  },
});

describe("schema-aware db typing", () => {
  it("accepts declared columns + system columns", () => {
    expect(dbGet({ table: users, fieldName: "email", fieldValue: c.int(1) }).name).toBe(
      "mvp:dbo_getby",
    );
    // system columns are part of the column union
    expect(dbGet({ table: users, fieldName: "id", fieldValue: c.int(1) }).name).toBe(
      "mvp:dbo_getby",
    );
    const q = dbQuery({
      table: users,
      sort: [{ sortBy: "created_at", dir: "desc" }],
      output: ["username", "email"],
    });
    expect(q.name).toBe("mvp:dbo_view");
    expect(dbAdd({ table: users, row: { username: c.text("a"), email: c.text("b") } }).name).toBe(
      "mvp:dbo_add",
    );
  });

  it("rejects unknown columns at compile time", () => {
    // Type-only: never invoked. The @ts-expect-error lines fail the typecheck if
    // the column unions ever stop rejecting these typos.
    const _typeOnly = (): void => {
      // @ts-expect-error "emial" is not a column of `users`
      dbGet({ table: users, fieldName: "emial", fieldValue: c.int(1) });
      // @ts-expect-error "nope" is not a column of `users`
      dbQuery({ table: users, output: ["nope"] });
      // @ts-expect-error "handle" is not a column of `users`
      dbAdd({ table: users, row: { handle: c.text("a") } });
    };
    expect(typeof _typeOnly).toBe("function");
  });

  it("falls back to loose typing for a bare-name table ref", () => {
    // No schema available behind a string ref → any field name is accepted.
    expect(dbGet({ table: "user", fieldName: "anything", fieldValue: c.int(1) }).name).toBe(
      "mvp:dbo_getby",
    );
  });
});
