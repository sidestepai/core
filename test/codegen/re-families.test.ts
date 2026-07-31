/**
 * R-E — the three families the sweep left undiagnosed, each settled by a live
 * engine round trip (`scripts/probe-re-families.ts`) rather than by reasoning
 * about the stored bytes.
 *
 * All three turned out to be the same shape of question: the engine ACCEPTS more
 * than one spelling and PERSISTS whichever it is given. So in every case the fix
 * is to let the SDK say the thing the engine already stores, not to pick a
 * winner and canonicalize the other away.
 *
 *   • `create_image` (26 statements) carries an `input[]` its declared context
 *     schema has no slot for. The engine keeps it verbatim, so dropping it would
 *     discard a stored binding.
 *   • `create_auth` (25) stores its four named entries in two orders. Both mint
 *     a token, and each order comes back exactly as sent.
 *   • `precondition` (6) stores `error` as a bare string where the schema
 *     declares a value. Both spellings survive a round trip unchanged.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js";
import { s } from "../../src/statements/s.js";
import { expr } from "../../src/statements/expression.js";
import { encodeStatement } from "../../src/statements/statement.js";
import type { StackItemXdo } from "../../src/types/xdo.js";
import { normalize } from "../../src/validate/normalize.js";
import { c, ref } from "../../src/values/value.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeStatement } from "../../src/codegen/statement.js";

const USERS = { name: "users", guid: "1111000000000000000000000000aaaa" };
const REFS = RefIndex.fromPayload({ dbo: [USERS] }, new DecodeContext());

function decode(stored: StackItemXdo): string {
  return printExpr(decodeStatement(new DecodeContext(), REFS, stored));
}

/** One rich input entry in the stored spelling. */
function entry(name: string, value: string, tag: string): Record<string, unknown> {
  return { name, value, tag, filters: [], ignore: false, expand: false, children: [] };
}

describe("create_image carries an input[] its schema does not declare", () => {
  const stored = {
    as: "image",
    name: "mvp:create_image",
    addon: [],
    input: [entry("id", "id", "auth")],
    output: { items: [], filters: [], customize: false },
    context: { tag: "input", value: "content", filters: [] },
    disabled: false,
    description: "",
    settings_registry: null,
  } as unknown as StackItemXdo;

  it("decodes to the real statement, with the stored entries spread over it", () => {
    const source = decode(stored);
    expect(source).toContain("s.storage.create_image(");
    expect(source).toContain("input:");
    expect(source).toContain('tag: "auth"');
    expect(source).not.toContain("raw(");
  });

  it("never lets the passthrough mask a statement's OWN input entries", () => {
    // The paired negative, and the reason this is safe to apply generally: the
    // stored `input[]` is carried only when the factory produced none of its own.
    // A statement that declares its entries must still be compared on them, or a
    // wrong decode would be silently papered over.
    const auth = encodeStatement(
      s.security.create_auth_token({ table: USERS, id: c.int(1), as: "tok" }),
    ) as StackItemXdo;
    const tampered = structuredClone(auth);
    (tampered.input as Array<Record<string, unknown>>)[0]!.value = "999";

    const source = decode(tampered);
    // Decoding recovers the TAMPERED id (999), not the original — the entries are
    // read, not passed through.
    expect(source).toContain("999");
    expect(normalize(encodeStatement(evaluateAuth(source)))).toEqual(normalize(tampered));
  });
});

/** Evaluate an emitted `s.security.create_auth_token(...)` back to a statement. */
function evaluateAuth(source: string): ReturnType<typeof s.security.create_auth_token> {
  const fn = new Function("s", "c", "ref", "users", `return (${source});`);
  return fn(s, c, ref, USERS) as ReturnType<typeof s.security.create_auth_token>;
}

describe("create_auth stores its named entries in either order", () => {
  const ORDERS: ReadonlyArray<readonly [string, readonly string[]]> = [
    // 21 of 25 real statements.
    ["stored-majority", ["dbtable", "extras", "expiration", "id"]],
    // 4 of 25 — the order the SDK writes.
    ["sdk", ["id", "dbtable", "extras", "expiration"]],
  ];

  const VALUES: Record<string, readonly [string, string]> = {
    dbtable: [USERS.guid, "const"],
    extras: ["{}", "const:obj"],
    expiration: ["86400", "const:int"],
    id: ["1", "const:int"],
  };

  for (const [label, order] of ORDERS) {
    it(`decodes the ${label} order without falling back`, () => {
      const stored = {
        as: "tok",
        name: "mvp:create_auth",
        addon: [],
        input: order.map((name) => entry(name, VALUES[name]![0], VALUES[name]![1])),
        output: { items: [], filters: [], customize: false },
        context: {},
        disabled: false,
        description: "",
        settings_registry: null,
      } as unknown as StackItemXdo;

      const source = decode(stored);
      expect(source).toContain("s.security.create_auth_token(");
      expect(source).not.toContain("raw(");
      // Both orders compare equal to what the SDK re-encodes, which is the whole
      // point — the entries are named parameters and position carries nothing.
      expect(normalize(encodeStatement(evaluateAuth(source)))).toEqual(normalize(stored));
    });
  }

  /**
   * A `dbtable` the bundle does not resolve as a guid — which older workspaces
   * produce by storing the table's NAME here.
   *
   * **SideStep resolves references by guid only** and never maps a name back to
   * an object, so the two cases below are deliberately indistinguishable to it.
   * Nor could it distinguish them another way: a workspace guid is an arbitrary
   * unique key anyone can change, so there is no shape to test. Both carry the
   * value verbatim and both report the same unresolved reference.
   */
  function storedNamed(dbtable: string): StackItemXdo {
    return {
      as: "tok",
      name: "mvp:create_auth",
      addon: [],
      input: [entry("id", "1", "const:int"), entry("dbtable", dbtable, "const")],
      output: { items: [], filters: [], customize: false },
      context: {},
      disabled: false,
      description: "",
      settings_registry: null,
    } as unknown as StackItemXdo;
  }

  for (const [label, dbtable] of [
    ["whose table is in the bundle", USERS.name],
    ["whose table is NOT in the bundle", "user"],
  ] as const) {
    it(`carries a name-spelled dbtable ${label}, reported the same way`, () => {
      // Regression on both halves. Keying the check on "a table of that name
      // exists" was a name lookup in all but direction, AND it let the absent
      // case fall through to guid resolution, which reported
      // `guid user is not present in this bundle` — an error about a guid that
      // was never a guid, 6 times in the survey corpus.
      const ctx = new DecodeContext();
      const stored = storedNamed(dbtable);
      const source = printExpr(decodeStatement(ctx, REFS, stored));

      expect(source).not.toContain("raw(");
      expect(normalize(encodeStatement(evaluateAuth(source)))).toEqual(normalize(stored));
      // Reported as what is literally known — the reference did not resolve —
      // with both readings named and neither asserted.
      expect(ctx.report.entries.map((e) => e.category)).toEqual(["unresolved-ref"]);
      expect(ctx.report.entries[0]!.detail).toContain("by guid only");
      // NOT the old `guid <x> is not present in this bundle`, which called a
      // value a guid on no evidence.
      expect(ctx.report.entries[0]!.detail).not.toMatch(/^guid /);
    });
  }

  it("resolves a GUID-spelled dbtable to the table's symbol, and reports nothing", () => {
    // The paired positive: dropping the name lookup must not cost the guid path
    // its resolution, which is the only mapping SideStep does.
    const ctx = new DecodeContext();
    const stored = storedNamed(USERS.guid);
    const source = printExpr(decodeStatement(ctx, REFS, stored));

    expect(source).not.toContain("raw(");
    expect(normalize(encodeStatement(evaluateAuth(source)))).toEqual(normalize(stored));
    expect(ctx.report.entries).toEqual([]);
  });

  it("still compares the entry VALUES — sorting is not a licence to ignore them", () => {
    // The paired negative the invariant requires: reordering compares equal, but
    // a changed value must not.
    const base = encodeStatement(
      s.security.create_auth_token({ table: USERS, id: c.int(1), as: "tok" }),
    );
    const changed = encodeStatement(
      s.security.create_auth_token({ table: USERS, id: c.int(2), as: "tok" }),
    );
    expect(normalize(base)).not.toEqual(normalize(changed));
  });

  it("does NOT sort input[] on statements where position is meaningful", () => {
    // A row write's entries are positional to the reader and a lookup's lead with
    // field_name/field_value. Sorting those would make a real reordering
    // invisible, so the rule is scoped to the one statement it was proven for.
    const rowOrder = encodeStatement(
      s.db.add({
        table: USERS,
        data: [
          { name: "b", value: c.int(1) },
          { name: "a", value: c.int(2) },
        ],
      }),
    );
    const swapped = encodeStatement(
      s.db.add({
        table: USERS,
        data: [
          { name: "a", value: c.int(2) },
          { name: "b", value: c.int(1) },
        ],
      }),
    );
    expect(normalize(rowOrder)).not.toEqual(normalize(swapped));
  });
});

describe("precondition stores its error as a bare string or a tagged value", () => {
  it("writes a bare string bare", () => {
    const enc = encodeStatement(
      s.precondition({
        expr: expr(ref("status"), "=", c.int(200)),
        error: "Access Denied.",
        error_type: "accessdenied",
      }),
    );
    expect((enc.context as { error: unknown }).error).toBe("Access Denied.");
  });

  it("still writes a tagged value as a tagged value", () => {
    const enc = encodeStatement(
      s.precondition({
        expr: expr(ref("status"), "=", c.int(200)),
        error: c.text("Access Denied."),
      }),
    );
    expect((enc.context as { error: { tag?: string } }).error).toMatchObject({ tag: "const" });
  });

  it("decodes a stored bare string back to a bare string", () => {
    // Built through the encoder and then rewritten to the editor's spelling, so
    // the ONLY thing that differs from a statement known to decode is `error`.
    const stored = structuredClone(
      encodeStatement(
        s.precondition({
          expr: expr(ref("status"), "=", c.int(200)),
          error: c.text("Access Denied."),
          error_type: "accessdenied",
        }),
      ),
    ) as StackItemXdo;
    (stored.context as { error: unknown }).error = "Access Denied.";

    const source = decode(stored);
    expect(source).toContain('error: "Access Denied."');
    expect(source).not.toContain("raw(");
  });
});
