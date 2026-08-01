/**
 * Database `!map:dbo` family (U10) — byte-shape proof against the engine's
 * transform-temp goldens. Each fixture stores the table as a local numeric id
 * (`context.dbo.id`) that the export path converts to the table's guid; sidestep
 * references by guid directly, so we align the fixture's id to the derived guid
 * and deep-equal everything else (the rich envelope + rich input entries).
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register kinds + statements
import {
  dbAdd,
  dbEdit,
  dbAddOrEdit,
  dbGet,
  dbDel,
  dbHas,
  dbPatch,
  dbTruncate,
  dbSchema,
  dbDirectQuery,
} from "../../src/statements/special/db.js";
import { encodeStatement } from "../../src/statements/statement.js";
import type { Statement } from "../../src/statements/statement.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { Xano } from "../../src/workspace/xano.js";
import { defineFunction } from "../../src/function/define.js";
import { table } from "../../src/kinds/table.js";
import { c, col, ref, filter, withFilters } from "../../src/values/value.js";
import { f } from "../../src/fields/catalog.js";
import { normalize, loadFixture } from "../conformance/harness.js";

const T = { name: "t" }; // stand-in table ref; only its name feeds the guid

/** Deep-equal a built db op against its fixture, with the table id aligned to the guid. */
function expectShape(fixtureName: string, built: ReturnType<typeof encodeStatement>) {
  const fixture = loadFixture(`statements/${fixtureName}.json`) as {
    context: { dbo: { id: unknown } };
  };
  fixture.context.dbo.id = deriveGuid("dbo", T.name);
  expect(normalize(built)).toEqual(normalize(fixture));
}

describe("db !map:dbo family — byte-shape vs transform-temp goldens", () => {
  it("db.get → dbo_getby", () => {
    // `lock` is authored explicitly here because the entry is `?=false` in the
    // engine schema and is now emitted only when set — which is what this
    // fixture's vintage recorded. Omitting it emits no entry at all (covered below).
    expectShape(
      "db_get",
      encodeStatement(dbGet({ table: T, as: "test1", fieldValue: c.int(123), lock: false })),
    );
  });

  it("db.get omits the `lock` entry entirely when it is not authored", () => {
    // Matching Xano 1:1: its editor writes no `lock` entry for an unlocked read,
    // so neither do we. The engine reads an absent `lock` as false.
    const encoded = encodeStatement(dbGet({ table: T, as: "test1", fieldValue: c.int(123) }));
    expect((encoded.input as Array<{ name: string }>).map((e) => e.name)).toEqual([
      "field_name",
      "field_value",
    ]);
  });

  it("db.del → dbo_delby", () => {
    expectShape("db_del", encodeStatement(dbDel({ table: T, as: "user3", fieldValue: c.int(123) })));
  });

  it("db.has → dbo_hasby", () => {
    expectShape("db_has", encodeStatement(dbHas({ table: T, as: "testb1", fieldValue: c.int(1) })));
  });

  it("db.patch → dbo_patch", () => {
    expectShape(
      "db_patch",
      encodeStatement(dbPatch({ table: T, as: "testb2", fieldValue: c.int(123), data: c.obj({}) })),
    );
  });

  it("db.truncate → dbo_truncate (empty as, reset false)", () => {
    // `reset?=false` — authored explicitly, for the same reason as `db.get`'s lock.
    expectShape("db_truncate", encodeStatement(dbTruncate({ table: T, as: "", reset: false })));
  });

  it("db.truncate omits the `reset` entry entirely when it is not authored", () => {
    expect(encodeStatement(dbTruncate({ table: T, as: "" })).input).toEqual([]);
  });

  it("db.schema → dbo_get_schema", () => {
    expectShape("db_schema", encodeStatement(dbSchema({ table: T, as: "testb3", path: c.text("id") })));
  });

  it("db.add → dbo_add (row entries, id ignored)", () => {
    expectShape(
      "db_add",
      encodeStatement(
        dbAdd({
          table: T,
          as: "user2",
          data: [
            { name: "id", value: c.null(), ignore: true },
            { name: "created_at", value: c.text("now") },
            { name: "name", value: c.text("test") },
            { name: "email", value: c.text("test@aol.com") },
            { name: "password", value: c.null() },
            { name: "_test", value: c.text("abc") },
            { name: "_abc", value: c.text("abc") },
            { name: "num", value: c.array([]) },
            { name: "json", value: c.obj({}) },
            { name: "@meta", value: c.null() },
            { name: "hehe", value: c.text("abc") },
          ],
        }),
      ),
    );
  });

  it("db.edit → dbo_editby (lookup + row entries, system fields ignored)", () => {
    expectShape(
      "db_edit",
      encodeStatement(
        dbEdit({
          table: T,
          as: "testb1",
          fieldValue: c.int(123),
          data: [
            { name: "id", value: c.null(), ignore: true },
            { name: "created_at", value: c.text("now"), ignore: true },
            { name: "external_id", value: c.text("test") },
            { name: "@meta", value: c.null(), ignore: true },
          ],
        }),
      ),
    );
  });

  it("db.add_or_edit → dbo_addoreditby (lean entries, opt-in tableAlias, no envelope)", () => {
    // The fixture carries `context.dbo.as`, so the authoring call opts in with
    // `tableAlias`. It used to be written unconditionally, which made
    // add_or_edit the one db statement that forced a SQL table name on every
    // caller — measured across four engine-authored workspaces, Xano writes the
    // alias per statement (dbo_getby: 4 with, 9 without; dbo_add: 8 without).
    const fixture = loadFixture("statements/db_add_or_edit.json") as {
      context: { dbo: { id: unknown; as: unknown } };
    };
    fixture.context.dbo.id = deriveGuid("dbo", T.name);
    fixture.context.dbo.as = T.name;
    const built = encodeStatement(
      dbAddOrEdit({
        table: T,
        as: "user12",
        tableAlias: T.name,
        fieldValue: c.text(""),
        data: [
          { name: "created_at", value: c.text(""), ignore: true },
          { name: "name", value: c.text(""), ignore: true },
          { name: "email", value: c.null(), ignore: true },
          { name: "password", value: c.null(), ignore: true },
          { name: "_test", value: c.text(""), ignore: true },
          { name: "_abc", value: c.text(""), ignore: true },
          { name: "num", value: c.text(""), ignore: true },
          { name: "json", value: c.text(""), ignore: true },
          { name: "@meta", value: c.null(), ignore: true },
          { name: "hehe", value: c.text(""), ignore: true },
        ],
      }),
    );
    expect(normalize(built)).toEqual(normalize(fixture));
  });

  it("db.direct_query → dbo_direct_query (raw SQL, bind args with filters, no table ref)", () => {
    const fixture = loadFixture("statements/db_direct_query.json");
    const built = encodeStatement(
      dbDirectQuery({
        sql: "select 1;",
        responseType: "list",
        as: "x2",
        args: [
          c.text("a"),
          withFilters(c.text("b"), [filter("concat", c.text("b"), c.text(""))]),
        ],
      }),
    );
    expect(normalize(built)).toEqual(normalize(fixture));
  });

  it("field_name defaults to the primary key 'id'", () => {
    const enc = encodeStatement(dbGet({ table: T, fieldValue: c.int(5) }));
    const fieldName = (enc.input as Array<{ name: string; value: string }>).find(
      (e) => e.name === "field_name",
    );
    expect(fieldName?.value).toBe("id");
  });

  describe("db.get output column selection (dbo_getby customized output)", () => {
    it("omitted output keeps the default envelope (customize:false, no items)", () => {
      const enc = encodeStatement(dbGet({ table: T, fieldValue: c.int(5) }));
      expect(enc.output).toEqual({ customize: false, filters: [], items: [] });
    });

    it("an empty output list normalizes to the full-record default envelope", () => {
      const enc = encodeStatement(dbGet({ table: T, fieldValue: c.int(5), output: [] }));
      expect(enc.output).toEqual({ customize: false, filters: [], items: [] });
    });

    it("output list emits the engine's customized envelope, byte-equal to the auth-me golden", () => {
      // The vendored `query-auth-me` golden (quick-start `auth/me`) carries the
      // engine's persisted shape for a dbo_getby with `output = [...]`.
      const golden = loadFixture(`query/query-auth-me.json`) as {
        run: Array<{ name: string; output: unknown }>;
      };
      const goldenGet = golden.run.find((s) => s.name === "mvp:dbo_getby");
      const enc = encodeStatement(
        dbGet({ table: T, fieldValue: c.int(5), output: ["id", "created_at", "name", "email"] }),
      );
      expect(enc.output).toEqual(goldenGet?.output);
    });

    it("items preserve author order with empty children", () => {
      const enc = encodeStatement(
        dbGet({ table: T, fieldValue: c.int(5), output: ["email", "id"] }),
      );
      expect(enc.output).toEqual({
        customize: true,
        filters: [],
        items: [
          { name: "email", children: [] },
          { name: "id", children: [] },
        ],
      });
    });

    it("output columns are schema-typed on a typed table def", () => {
      const users = table({
        name: "user",
        schema: { email: f.email() },
      });
      // valid columns (declared + system) compile; an unknown column is a type error
      dbGet({ table: users, fieldValue: c.int(1), output: ["email", "id"] });
      // @ts-expect-error — 'nope' is not a column of `users`
      dbGet({ table: users, fieldValue: c.int(1), output: ["nope"] });
    });

    it("types a dotted sub-key path by its root column", () => {
      const users = table({
        name: "user",
        schema: { email: f.email(), password_reset: f.json() },
      });
      // A dotted path selects sub-keys of a declared column; the sub-keys of an
      // object column are not declared, so only the root is checked.
      dbGet({ table: users, fieldValue: c.int(1), output: ["password_reset.token"] });
      // @ts-expect-error — 'nope' is still not a column, dotted or not
      dbGet({ table: users, fieldValue: c.int(1), output: ["nope.token"] });

    });
  });

  describe("schema-driven row expansion (DX — reachable, not byte-verified)", () => {
    const users = table({
      name: "user",
      schema: [
        { name: "id", type: "int", required: true },
        { name: "created_at", type: "epochms", default: "now", access: "private" },
        { name: "name", type: "text" },
        { name: "tags", type: "text", array: true },
        { name: "meta", type: "json" },
      ],
    });

    type Entry = { name: string; value: string; tag: string; ignore: boolean };
    const inputOf = (s: ReturnType<typeof encodeStatement>) => s.input as Entry[];

    it("db.add expands a partial row: one entry per column, type defaults, id ignored", () => {
      const input = inputOf(encodeStatement(dbAdd({ table: users, row: { name: c.text("jo") } })));
      expect(input.map((e) => e.name)).toEqual(["id", "created_at", "name", "tags", "meta"]);
      expect(input.map((e) => [e.value, e.tag])).toEqual([
        ["null", "const:null"], // id → null (no default)
        ["now", "const"], // created_at → declared default
        ["jo", "const"], // author-supplied
        ["[]", "const:array"], // array column default
        ["{}", "const:obj"], // json column default
      ]);
      // add ignores only the primary key
      expect(input.filter((e) => e.ignore).map((e) => e.name)).toEqual(["id"]);
    });

    it("db.edit ignores system columns AND unmentioned columns (partial edit, issue #33)", () => {
      const input = inputOf(
        encodeStatement(dbEdit({ table: users, fieldValue: c.int(1), row: { name: c.text("x") } })),
      );
      // A partial edit writes only the supplied column; every other column —
      // system (id/created_at) or merely unmentioned (tags/meta) — is emitted
      // with ignore:true so the stored value is preserved, not nulled.
      const ignored = input.filter((e) => e.ignore).map((e) => e.name);
      expect(ignored).toEqual(["id", "created_at", "tags", "meta"]);
      const written = input.filter((e) => e.name !== "field_name" && e.name !== "field_value" && !e.ignore);
      expect(written.map((e) => e.name)).toEqual(["name"]);
      // lookup pair still leads, then the expanded columns
      expect(input.slice(0, 2).map((e) => e.name)).toEqual(["field_name", "field_value"]);
    });

    it("db.edit treats an explicitly supplied null as a write, not an omission (issue #33)", () => {
      // The crux of the fix: `supplied` is `row[col.name] !== undefined`, so an
      // author who writes `{ tags: null }` sets the column to null (ignore:false,
      // the null emitted), whereas omitting `tags` preserves the stored value
      // (ignore:true). A nullish `??` check would conflate the two.
      const input = inputOf(
        encodeStatement(dbEdit({ table: users, fieldValue: c.int(1), row: { tags: c.null() } })),
      );
      const tags = input.find((e) => e.name === "tags")!;
      expect(tags.ignore).toBe(false); // supplied → written, NOT preserved
      expect([tags.value, tags.tag]).toEqual(["null", "const:null"]); // author's null, not a type default
      // an unmentioned column is still ignored (stored value preserved)
      expect(input.find((e) => e.name === "meta")!.ignore).toBe(true);
    });

    it("db.edit with an empty row ignores every column (writes nothing)", () => {
      const input = inputOf(encodeStatement(dbEdit({ table: users, fieldValue: c.int(1), row: {} })));
      const written = input.filter(
        (e) => e.name !== "field_name" && e.name !== "field_value" && !e.ignore,
      );
      expect(written).toEqual([]);
    });

    it("db.edit that supplies every column ignores only the system columns", () => {
      const input = inputOf(
        encodeStatement(
          dbEdit({
            table: users,
            fieldValue: c.int(1),
            row: { name: c.text("a"), tags: c.array([]), meta: c.obj({}) },
          }),
        ),
      );
      expect(input.filter((e) => e.ignore).map((e) => e.name)).toEqual(["id", "created_at"]);
    });

    it("rejects a row key that is not a column (typo guard)", () => {
      expect(() => dbAdd({ table: users, row: { nope: c.text("x") } })).toThrow(/not a column/);
    });

    it("rejects col() in a row at the type level — the issue #32 footgun", () => {
      // `col()` (and any filter chain built from it) does not resolve to the
      // stored value inside a db.edit/db.add `row` — it evaluates to null at
      // runtime and the engine aborts. The `__col` brand turns that live-only
      // failure into a compile error. These builds still succeed at runtime
      // (nothing throws); the assertions are the @ts-expect-error markers.
      // @ts-expect-error — bare col() is not a legal row cell
      dbEdit({ table: users, fieldValue: c.int(1), row: { name: col("name") } });
      // @ts-expect-error — the actual reported form: col() wrapped in withFilters
      dbEdit({ table: users, fieldValue: c.int(1), row: { name: withFilters(col("name"), filter("add", c.int(1))) } });
      // The documented fix (read-back via ref) stays legal.
      dbEdit({
        table: users,
        fieldValue: c.int(1),
        row: { name: withFilters(ref("current.name"), filter("add", c.int(1))) },
      });
    });

    it("requires the table definition (a bare name carries no schema)", () => {
      expect(() => dbAdd({ table: "user", row: { name: c.text("x") } })).toThrow(/row expansion needs/);
    });

    it("row expansion sees auto-injected system columns (table without explicit id/created_at)", () => {
      const posts = table({ name: "post", schema: [{ name: "title", type: "text" }] });
      const input = inputOf(encodeStatement(dbAdd({ table: posts, row: { title: c.text("hi") } })));
      expect(input.map((e) => e.name)).toEqual(["id", "created_at", "title"]);
      expect(input.find((e) => e.name === "id")?.ignore).toBe(true);
    });

    it("explicit data path is unchanged by the row option", () => {
      const input = inputOf(
        encodeStatement(dbAdd({ table: users, data: [{ name: "name", value: c.text("only") }] })),
      );
      expect(input.map((e) => e.name)).toEqual(["name"]);
    });
  });

  it("round-trip: a db op resolves to the guid the table emits in the bundle", () => {
    const users = table({ name: "user", schema: [{ name: "id", type: "int" }] });
    const fn = defineFunction({
      name: "reader",
      stack: [dbGet({ table: users, as: "u", fieldValue: c.int(1) })],
    });
    const bundle = new Xano().registerTables([users]).registerFunctions([fn]).export();
    const dbo = (bundle.payload.dbo as Array<{ name: string; guid: string }>).find(
      (d) => d.name === "user",
    )!;
    const stack = (bundle.payload.function as Array<{ name: string; run: unknown[] }>)[0]!.run;
    const op = stack[0] as { context: { dbo: { id: string } } };
    expect(op.context.dbo.id).toBe(dbo.guid);
  });
});

/**
 * `context.dbo.as` supplies the table's name in the GENERATED SQL, replacing
 * Xano's own generated name — it is not a cosmetic alias. So it is opt-in on
 * every db statement, and a duplicate is a workspace-level conflict.
 *
 * Measured read-only across four engine-authored workspaces: Xano writes the
 * alias per statement, not per statement type (`dbo_getby` 4 with / 9 without,
 * `dbo_add` 8 without). `add_or_edit` used to write it unconditionally, making
 * it the only db statement that forced a SQL name on every caller.
 */
describe("tableAlias — opt-in, and unique across the workspace", () => {
  it("omits context.dbo.as from add_or_edit when no tableAlias is given", () => {
    const built = encodeStatement(
      dbAddOrEdit({ table: T, fieldValue: c.text("x"), data: [] }),
    ) as { context: { dbo: Record<string, unknown> } };
    expect(Object.hasOwn(built.context.dbo, "as")).toBe(false);
    expect(built.context.dbo.id).toBe(deriveGuid("dbo", T.name));
  });

  it("writes context.dbo.as on add_or_edit only when tableAlias is set", () => {
    const built = encodeStatement(
      dbAddOrEdit({ table: T, fieldValue: c.text("x"), data: [], tableAlias: "u" }),
    ) as { context: { dbo: Record<string, unknown> } };
    expect(built.context.dbo.as).toBe("u");
  });

  it("honours tableAlias on every db op that declares it", () => {
    // `db.edit` declared and documented the option but never forwarded it, so it
    // was silently dropped — and a stored dbo_editby carrying `context.dbo.as`
    // could not round-trip and fell to `raw()`. Table-driven so the next op to
    // declare the option without wiring it fails here.
    const ops: Array<[string, Statement]> = [
      ["db.get", dbGet({ table: T, fieldValue: c.text("x"), tableAlias: "u" })],
      ["db.del", dbDel({ table: T, fieldValue: c.text("x"), tableAlias: "u" })],
      ["db.has", dbHas({ table: T, fieldValue: c.text("x"), tableAlias: "u" })],
      ["db.patch", dbPatch({ table: T, fieldValue: c.text("x"), data: c.obj({}), tableAlias: "u" })],
      ["db.add", dbAdd({ table: T, data: [], tableAlias: "u" })],
      ["db.edit", dbEdit({ table: T, fieldValue: c.text("x"), data: [], tableAlias: "u" })],
      ["db.add_or_edit", dbAddOrEdit({ table: T, fieldValue: c.text("x"), data: [], tableAlias: "u" })],
    ];
    for (const [label, statement] of ops) {
      const built = encodeStatement(statement) as { context: { dbo: Record<string, unknown> } };
      expect(built.context.dbo.as, label).toBe("u");
    }
  });

  it("emits an empty-string alias when asked, rather than treating it as unset", () => {
    // Presence, not truthiness — `as: ""` is a shape the engine can store.
    const built = encodeStatement(
      dbAddOrEdit({ table: T, fieldValue: c.text("x"), data: [], tableAlias: "" }),
    ) as { context: { dbo: Record<string, unknown> } };
    expect(Object.hasOwn(built.context.dbo, "as")).toBe(true);
    expect(built.context.dbo.as).toBe("");
  });
});

/**
 * `enforceHiddenFields` — refusing to auto-wire request inputs the endpoint
 * never bound.
 *
 * A row write auto-wires any column whose name matches an incoming request
 * input. With this on, the engine consults the endpoint's input whitelist and
 * skips anything outside it — so it is a security-relevant setting, not a
 * formatting one. (The engine-side detail is documented in the decoder, which
 * is internal and does not ship in the published types.)
 *
 * OFF is the engine's own default (`enforce_hidden_fields?=false`, read as
 * `?? false` by all three statement classes), and the key must stay ABSENT then:
 * all 557 stored `dbo_add` statements in the 177-project corpus omit it, and
 * writing a redundant `false` would change the bytes of every row write.
 */
describe("db row writes — enforceHiddenFields", () => {
  const ctxOf = (s: Statement) =>
    (encodeStatement(s) as unknown as { context: Record<string, unknown> }).context;

  it("writes the key only when ON", () => {
    expect(ctxOf(dbAdd({ table: T, data: [] }))).not.toHaveProperty("enforce_hidden_fields");
    expect(ctxOf(dbAdd({ table: T, data: [], enforceHiddenFields: true }))).toMatchObject({
      enforce_hidden_fields: true,
    });
  });

  it("stays absent when explicitly OFF, because absent IS off", () => {
    // The engine reads `?? false`, so a written `false` would be a redundant
    // byte on every row write that opts out by name.
    expect(ctxOf(dbAdd({ table: T, data: [], enforceHiddenFields: false }))).not.toHaveProperty(
      "enforce_hidden_fields",
    );
  });

  it("covers all three statements the engine declares it on", () => {
    // The three row writes that declare it — and no others.
    for (const built of [
      dbAdd({ table: T, data: [], enforceHiddenFields: true }),
      dbEdit({ table: T, fieldValue: c.int(1), data: [], enforceHiddenFields: true }),
      dbAddOrEdit({ table: T, fieldValue: c.int(1), data: [], enforceHiddenFields: true }),
    ]) {
      expect(ctxOf(built)).toMatchObject({ enforce_hidden_fields: true });
    }
  });
});
