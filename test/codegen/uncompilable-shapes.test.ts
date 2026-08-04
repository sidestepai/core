/**
 * Stored shapes that round-tripped perfectly and produced a tree that would not
 * COMPILE.
 *
 * Every case here was found the same way: a live sweep reported 0 round-trip
 * mismatches while `tsc` over the generated trees reported 228 errors across 25
 * of 176 workspaces. Round-tripping and compiling are different questions —
 * `tsx` strips types, so verification imports and re-exports an ill-typed tree
 * without noticing — and this file is the second question, asked per shape.
 *
 * Two failure modes recur, and the fixes differ:
 *
 * - **The SDK elided a default by matching ONE spelling of it.** The engine
 *   writes several (`cors` at `mode:"default"` vs a legacy `enabled:false`;
 *   `output` as `{items:[],filters:[]}`, `null`, `{filters:[]}`, or `{}`), so the
 *   unmatched ones leaked into the source as values no author would write and no
 *   type accepts. The fix is always to ask `normalize` — the oracle the round
 *   trip is judged against — rather than to compare against a literal.
 * - **The SDK's type was stricter than what the engine stores.** A `json`-typed
 *   numeric control persists `""`; a column selection may name a joined table or
 *   a computed alias. The fix is to widen to what the engine actually holds,
 *   never to elide, because eliding would make the encoder invent a value.
 */
import { describe, it, expect } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import { normalize } from "../../src/validate/normalize.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { printExpr } from "../../src/codegen/print.js";
import { decodeField } from "../../src/codegen/field.js";
import { encodeField, COLUMN_CONTEXT } from "../../src/fields/field.js";
import { agent } from "../../src/kinds/agent.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { c } from "../../src/values/value.js";
import { dbGet, dbQuery } from "../../src/statements/special/db.js";

/** The one generated file for a single-object bundle, as source text. */
function sourceOf(payload: Record<string, unknown>, path: string): string {
  const project = decodeBundle({ payload } as never);
  const file = project.files.find((f) => f.path === path);
  expect(file, `no generated file at ${path}\n${project.files.map((f) => f.path).join("\n")}`).toBeDefined();
  return file!.contents;
}

describe("elision matches the MEANING of a default, not one spelling of it", () => {
  const INERT_CORS = [
    ["the current spelling", { mode: "default", allowOrigins: [], allowHeaders: [], allowCredentials: false, maxAge: 0, allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false } }],
    // Predates `mode` entirely. 4 api groups in the sweep carry it, and
    // `CorsConfig` declares no `enabled`, so the emitted literal failed
    // excess-property checking and the whole tree stopped compiling.
    ["the legacy spelling", { enabled: false, allowOrigins: [], allowHeaders: [], allowCredentials: false, maxAge: 0, allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false } }],
  ] as const;

  it.each(INERT_CORS)("drops an inert cors block written in %s", (_label, cors) => {
    const source = sourceOf({ app: [{ name: "g", guid: "G1", cors }] }, "query/g.ts");
    expect(source).not.toContain("cors:");
    expect(source).not.toContain("enabled:");
  });

  it("keeps a cors block that actually configures something", () => {
    // A block applies only at `mode: "custom"`, which is exactly what makes the
    // two inert spellings equivalent — so this is the paired negative.
    const source = sourceOf(
      { app: [{ name: "g", guid: "G1", cors: { mode: "custom", allowOrigins: ["https://a.example"], allowHeaders: [], allowCredentials: false, maxAge: 0, allowMethods: { delete: false, get: false, head: false, patch: false, post: false, put: false } } }] },
      "query/g.ts",
    );
    expect(source).toContain("cors:");
    expect(source).toContain("https://a.example");
  });

  // All four are how the engine writes "this statement shapes no output"; only
  // the first was recognised, and `null` is not assignable to `OutputAuthored`.
  const EMPTY_OUTPUT = [
    ["the rich envelope", { customize: false, filters: [], items: [] }],
    ["a bare null", null],
    ["the lean envelope", { filters: [] }],
    ["an empty object", {}],
  ] as const;

  it.each(EMPTY_OUTPUT)("normalize calls %s an unshaped output", (_label, output) => {
    // The decoder's elision reads this same rule, so proving the rule proves the
    // elision cannot disagree with the comparison that judges the round trip.
    expect(normalize({ output })).toEqual({});
  });
});

describe("types admit what the engine actually stores", () => {
  it("emits an unenumerated method name in the explicit form, not the colon shorthand", () => {
    // `@` is the FK annotation and no field type's method union carries it, so
    // `"@:dbo="` did not type-check. 58 fields in the sweep hold one pointing at
    // nothing, which is precisely the case that rides `methods` verbatim.
    const stored = {
      ...encodeField("user_id", "int", {}, COLUMN_CONTEXT),
      methods: [{ name: "@", arg: ["dbo="], disabled: false }],
    };
    const source = printExpr(decodeField(new DecodeContext(), new RefIndex(), stored as never, "f").expr);
    expect(source).not.toContain('"@:dbo="');
    expect(source).toContain('name: "@"');
    // An ordinary method keeps the readable shorthand — the rule is about names
    // no union enumerates, not about abandoning the shorthand.
    const trimmed = {
      ...encodeField("name", "text", {}, COLUMN_CONTEXT),
      methods: [{ name: "trim", arg: [], disabled: false }],
    };
    expect(printExpr(decodeField(new DecodeContext(), new RefIndex(), trimmed as never, "f").expr)).toContain('"trim"');
  });
});

describe("type-level: the widenings the sweep proved necessary", () => {
  // Type-only. These never run — the assertion is that `npm run typecheck`
  // accepts them, so a narrowing regression fails the build rather than waiting
  // for a sweep to notice a tree stopped compiling.
  it("accepts every stored shape that used to be unspellable", () => {
    const _typeOnly = (): void => {
      // A `json`-typed numeric control persists `""` when untouched (18 of 30
      // stored temperatures are strings).
      agent({ name: "a", llm: { type: "xano-free", temperature: "", thinkingBudget: "" } });
      // A bare `const` holding null — 47 in the sweep, mostly ignored input
      // entries the engine never reads.
      c.text(null);

      const users = table({ name: "user", schema: { email: f.email() } });
      // A joined table's column, and the bound table's own alias.
      dbGet({ table: users, fieldValue: c.int(1), output: ["photo.id"] });
      dbGet({ table: users, fieldValue: c.int(1), fieldName: "google_oauth.id" });
      dbQuery({ table: users, sort: [{ sortBy: "comments.id", dir: "desc" }] });
      // The envelope a paged read wraps around the rows.
      dbQuery({ table: users, output: ["itemsReceived", "curPage", "items.email"] });
      // A computed column the same call declares.
      dbQuery({
        table: users,
        eval: [{ name: "user.$searchindex", as: "rank" }],
        sort: [{ sortBy: "rank", dir: "desc" }],
      });
    };
    expect(typeof _typeOnly).toBe("function");
  });

  it("still rejects a bare name no schema or eval declares", () => {
    const _typeOnly = (): void => {
      const users = table({ name: "user", schema: { email: f.email() } });
      // @ts-expect-error — 'emial' is a typo, not a column, and no dot excuses it
      dbGet({ table: users, fieldValue: c.int(1), output: ["emial"] });
      // @ts-expect-error — an eval alias the call does not declare
      dbQuery({ table: users, sort: [{ sortBy: "rank", dir: "desc" }] });
    };
    expect(typeof _typeOnly).toBe("function");
  });
});
