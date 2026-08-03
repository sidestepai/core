/**
 * U11 — the decode corpus over the vendored fixtures.
 *
 * `skeleton-roundtrip.test.ts` and `kinds.test.ts` both run against workspaces
 * *SideStep authored*, so they can only ever exercise shapes SideStep already
 * emits. These fixtures came off a real Xano engine, which makes them the one
 * corpus that can disagree with the encoder — the closest offline stand-in for
 * "decode someone else's workspace".
 *
 * The 118 fixtures are heterogeneous (statement envelopes, whole kind objects,
 * one field, plus files that are neither), so a single undifferentiated loop over
 * them is not well-defined. Each category gets its own entry point with its own
 * decode call and its own re-encode oracle.
 *
 * The assertion is the same everywhere: decode the stored JSON to source,
 * evaluate that source against the real authoring surface, re-encode, and require
 * `normalize()`-equality with the fixture. Evaluating the *emitted source* rather
 * than inspecting the decoder's internals is the point — it is the only way to
 * catch a decoder that emits something plausible but wrong.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../../src/index.js"; // load every kind + statement registration
import { normalize, loadFixture } from "./harness.js";
import { encodeObject } from "../../src/kinds/kind.js";
import { workspace } from "../../src/workspace/xano.js";
import type { TableDef } from "../../src/kinds/table.js";
import { encodeStatement, type Statement } from "../../src/statements/statement.js";
import { COLUMN_CONTEXT, encodeField } from "../../src/fields/field.js";
import type { FieldXdo } from "../../src/types/xdo.js";
import type { FieldDescriptor } from "../../src/fields/catalog.js";
import type { StackItemXdo } from "../../src/types/xdo.js";
import { DecodeContext } from "../../src/codegen/context.js";
import { printExpr } from "../../src/codegen/print.js";
import { RefIndex } from "../../src/codegen/ref-index.js";
import { decodeStatement } from "../../src/codegen/statement.js";
import { decodeField } from "../../src/codegen/field.js";
import { decodeObject as decodeKindObject, KIND_DECODERS_BY_NAME } from "../../src/codegen/kinds/index.js";

import { s } from "../../src/statements/s.js";
import { and, cmp, expr, or } from "../../src/statements/expression.js";
import { c, col, auth, env, inp, out, ref, setting, withFilters } from "../../src/values/value.js";
import { obj } from "../../src/values/obj.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { f } from "../../src/fields/catalog.js";
import { input } from "../../src/inputs/input.js";
import { rawValue } from "../../src/values/raw-value.js";
import { rawField } from "../../src/fields/raw-field.js";
import { rawResponse } from "../../src/responses/raw-response.js";
import { raw } from "../../src/statements/special/raw.js";

/** Everything a generated file can import, as one evaluation scope. */
const SURFACE = {
  s, c, ref, inp, col, auth, env, setting, out, obj,
  withFilters, fl, rawValue, rawField, rawResponse, raw, expr, cmp, and, or, f, input,
};

/** An empty index: a fixture stands alone, so every reference degrades to `{name, guid}`. */
const NO_REFS = RefIndex.fromPayload({}, new DecodeContext());

/** Evaluate emitted source against the real authoring surface. */
function evaluate(source: string): unknown {
  const names = Object.keys(SURFACE);
  const fn = new Function(...names, `return (${source});`);
  return fn(...names.map((name) => (SURFACE as Record<string, unknown>)[name]));
}

/** Every `.json` file in a fixture directory, sorted. */
function fixtureFiles(dir: string): string[] {
  const path = fileURLToPath(new URL(`../fixtures/${dir}/`, import.meta.url));
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

// ── statements ───────────────────────────────────────────────────────────────

describe("codegen corpus — statement fixtures", () => {
  const all = fixtureFiles("statements");
  // A statement fixture with no `name` is not a statement envelope — it is a
  // fragment vendored for one sub-encoder (`db_view_addon.json` is the addon
  // block of a `dbo_view` golden, used by `addon-encode.test.ts`). Decode's unit
  // is the whole envelope, so a fragment is out of scope rather than a failure.
  const files = all.filter((file) => loadFixture<{ name?: string }>(`statements/${file}`).name);

  it("covers the whole statement fixture directory bar the fragments", () => {
    // Guards the loop against silently shrinking: a fixture that stops being
    // enumerated would otherwise just stop being checked.
    expect(files.length).toBeGreaterThanOrEqual(79);
    expect(all.length - files.length).toBe(1);
  });

  for (const file of files) {
    it(`${file} decodes and re-encodes normalize()-equal`, () => {
      const stored = loadFixture<StackItemXdo>(`statements/${file}`);
      const ctx = new DecodeContext();
      const source = printExpr(decodeStatement(ctx, NO_REFS, stored));
      const reencoded = encodeStatement(evaluate(source) as Statement);
      expect(normalize(reencoded), `source: ${source}`).toEqual(normalize(stored));
    });
  }
});

// ── whole kind objects ───────────────────────────────────────────────────────

/**
 * Fixtures that are NOT bundle payload objects, with why.
 *
 * Decode's input is a `packageExport` payload. Three vendored fixtures are
 * something else, and no decoder can round-trip them because no *encoder*
 * produces them either:
 *
 * - `misc/addon.json`, `misc/workspace.json` — engine **meta-API records**, not
 *   bundle objects. They carry `@io`, `connect`, `domain_prefix` and friends,
 *   which a bundle export never emits. (`misc/task.json` and
 *   `misc/middleware.json` are the same vintage but their extra keys all
 *   normalize away, so they stay in the corpus.)
 * - `triggers/error-trigger.json` — documented stale: it stores `input: []` and
 *   predates the rich error-signature schema `impliedInputs("error")` now
 *   generates. `trigger-inputs.test.ts` asserts against that schema rather than
 *   this fixture for the same reason.
 *
 * The exclusions are asserted, not assumed — see the test below.
 */
const EXCLUDED: ReadonlyMap<string, string> = new Map([
  ["misc/addon.json", "@io"],
  ["misc/workspace.json", "domain_prefix"],
  ["triggers/error-trigger.json", "input"],
]);

/**
 * Fixture → the kind that persists it.
 *
 * Explicit rather than derived from the directory: `query/` holds an api-group,
 * `misc/` holds four different kinds, and `toolset/` holds all three of the
 * kinds that share that payload space. A wrong guess here would decode an object
 * with the wrong inverse and fail confusingly.
 */
const KIND_FIXTURES: ReadonlyArray<readonly [fixture: string, kind: string]> = [
  ...fixtureFiles("tables").map((f) => [`tables/${f}`, "table"] as const),
  ...fixtureFiles("triggers")
    .filter((f) => !EXCLUDED.has(`triggers/${f}`))
    .map((f) => [`triggers/${f}`, "trigger"] as const),
  ["query/ex_get_user.json", "query"],
  ["query/ex_ask_assistant.json", "query"],
  ["query/ex_history_query.json", "query"],
  ["query/query.json", "query"],
  ["query/query-auth-me.json", "query"],
  ["query/api-group.json", "api_group"],
  ["toolset/agent.json", "agent"],
  ["toolset/agent-structured.json", "agent"],
  ["toolset/ex_assistant.json", "agent"],
  ["toolset/ex_kind_mcp_server.json", "mcp_server"],
  ["toolset/tool.json", "tool"],
  ["toolset/ex_kind_search_tool.json", "tool"],
  ["middleware/ex_kind_rate_limit.json", "middleware"],
  ["misc/middleware.json", "middleware"],
  ["addon/ex_kind_author_addon.json", "addon"],
  ["task/ex_kind_nightly_cleanup.json", "task"],
  ["misc/task.json", "task"],
];

/**
 * Re-encode a decoded def the way the fixture's own vintage carries it.
 *
 * Tables come in two shapes here. `encodeTable` produces the *stored* dbo; the
 * engine additionally decorates each one with `import: { mode: "standard" }` at
 * **package-export** time, which is why `Xano.export()` writes it rather than the
 * kind encoder. The older `schema-table*.json` fixtures are stored-shape; the
 * capture-era ones (`ex_kind_products`, `ex_field_table_ref`) are export-shape.
 *
 * Matching the fixture's vintage keeps the assertion about the *decoder*. Always
 * using one path would report a difference the decoder neither caused nor could
 * fix, on whichever half of the corpus lost the coin toss.
 */
function reencode(kind: string, def: unknown, stored: Record<string, unknown>): unknown {
  if (kind !== "table" || !Object.hasOwn(stored, "import")) return encodeObject(kind, def);
  const payload = workspace("corpus").registerTables([def as TableDef]).export().payload as Record<
    string,
    Array<Record<string, unknown>>
  >;
  return payload.dbo![0];
}

describe("codegen corpus — whole kind objects", () => {
  it("excludes only fixtures that are demonstrably not bundle objects", () => {
    // Each exclusion names a key that proves it: if a fixture refresh ever makes
    // one of these bundle-shaped, this fails and the exclusion must be revisited.
    for (const [fixture, marker] of EXCLUDED) {
      const stored = loadFixture<Record<string, unknown>>(fixture);
      expect(Object.hasOwn(stored, marker), `${fixture} no longer carries ${marker}`).toBe(true);
    }
  });

  it("classifies every kind fixture it enumerates", () => {
    // The `toolset` discriminator is real stored content (`type`), so assert the
    // table agrees with it rather than trusting the filename.
    for (const [fixture, kind] of KIND_FIXTURES) {
      if (!fixture.startsWith("toolset/")) continue;
      const type = loadFixture<{ type?: string }>(fixture).type;
      const expected = type === "mcp" ? "mcp_server" : type === "agent" ? "agent" : "tool";
      expect(kind, fixture).toBe(expected);
    }
  });

  for (const [fixture, kind] of KIND_FIXTURES) {
    it(`${fixture} decodes as ${kind} and re-encodes normalize()-equal`, () => {
      const stored = loadFixture<Record<string, unknown>>(fixture);
      const decoder = KIND_DECODERS_BY_NAME.get(kind)!;
      const ctx = new DecodeContext();
      const source = printExpr(
        decodeKindObject(decoder, { ctx, refs: NO_REFS, stored, resolve: {} }).expr,
      );
      const reencoded = reencode(kind, evaluate(source), stored);
      expect(normalize(reencoded), `source: ${source}`).toEqual(normalize(stored));
    });
  }
});

// ── fields ───────────────────────────────────────────────────────────────────

describe("codegen corpus — field fixtures", () => {
  for (const file of fixtureFiles("fields")) {
    it(`${file} decodes and re-encodes normalize()-equal`, () => {
      const stored = loadFixture<FieldXdo>(`fields/${file}`);
      const ctx = new DecodeContext();
      const source = printExpr(decodeField(ctx, NO_REFS, stored, "f").expr);
      const back = evaluate(source) as FieldDescriptor;
      const reencoded = encodeField(stored.name, back.type, back.options, COLUMN_CONTEXT);
      expect(normalize(reencoded), `source: ${source}`).toEqual(normalize(stored));
    });
  }
});

// ── the raw-fallback floor ───────────────────────────────────────────────────

describe("codegen corpus — raw-fallback floor", () => {
  /**
   * Statement fixtures that still fall through to `raw()`, each with the reason
   * and a predicate that proves it.
   *
   * An explicit list, not a count. A new entry has to be a deliberate decision
   * written down; a fixture that *stops* falling back tightens the floor rather
   * than passing silently; and because each reason is checked against the fixture,
   * the list cannot quietly rot into folklore.
   *
   * All three reasons are fixture *vintage*, not decoder gaps — every one of these
   * still round-trips exactly through `raw()`, just unreadably.
   */
  const REASONS: Record<string, (stored: Record<string, any>) => boolean> = {
    // Pre-guid references: these predate guid-based identity and name their
    // target with a NUMERIC engine id. The authoring surface takes an `ObjectRef`,
    // which always resolves to a guid string, so a number has no inverse. A
    // `packageExport` bundle — decode's actual input — always carries guids.
    "numeric object reference": (stored) => {
      const ref = stored.context?.dbo?.id ?? stored.context?.function?.id;
      return typeof ref === "number";
    },
    // Hand-derived fixtures carrying a provenance note as a real key. No
    // authoring surface emits `_derived_from`, so no re-encode can reproduce it.
    "carries a `_derived_from` provenance annotation": (stored) =>
      Object.hasOwn(stored, "_derived_from"),
    // A nested child (`mvp:lambda`) stored with no `context` key at all — a
    // parser-generation shape. `encodeStatement` writes `context` on every
    // statement it builds, so no decoded call can reproduce its ABSENCE; only the
    // `raw()` arm can, and it does. That is an encoder-side property, not a
    // decoder gap: the same divergence is why several real-workspace statements
    // fall back too (the engine omits keys at their defaults, the SDK does not).
    "nested child stored with no `context` key": (stored) =>
      JSON.stringify(stored).includes('"mvp:lambda"'),
  };

  const EXPECTED_FALLBACKS: ReadonlyMap<string, string> = new Map([
    ["db_add.json", "numeric object reference"],
    ["db_add_or_edit.json", "numeric object reference"],
    ["db_del.json", "numeric object reference"],
    ["db_edit.json", "numeric object reference"],
    ["db_get.json", "numeric object reference"],
    ["db_has.json", "numeric object reference"],
    ["db_patch.json", "numeric object reference"],
    ["db_schema.json", "numeric object reference"],
    ["db_truncate.json", "numeric object reference"],
    ["function_run.json", "numeric object reference"],
    ["db_view_external.json", "carries a `_derived_from` provenance annotation"],
    ["db_view_simple_external.json", "carries a `_derived_from` provenance annotation"],
    ["db_view_where.json", "carries a `_derived_from` provenance annotation"],
    ["db_view_where_sort_paging_output.json", "carries a `_derived_from` provenance annotation"],
    ["switch.json", "nested child stored with no `context` key"],
  ]);

  it("matches the expected fallback list exactly", () => {
    const actual: string[] = [];
    for (const file of fixtureFiles("statements")) {
      const stored = loadFixture<StackItemXdo>(`statements/${file}`);
      if (!stored.name) continue; // a fragment, not an envelope — see above
      const ctx = new DecodeContext();
      decodeStatement(ctx, NO_REFS, stored);
      if (ctx.report.entries.some((e) => e.category === "raw-fallback")) actual.push(file);
    }
    expect(actual.sort()).toEqual([...EXPECTED_FALLBACKS.keys()].sort());
  });

  it("still holds each stated reason against the fixture", () => {
    // Without this the list is just an allowlist, and a decoder regression could
    // be waved through by appending a filename to it.
    for (const [file, reason] of EXPECTED_FALLBACKS) {
      const stored = loadFixture<Record<string, unknown>>(`statements/${file}`);
      expect(REASONS[reason]!(stored), `${file}: ${reason}`).toBe(true);
    }
  });

  it("round-trips every fallback exactly anyway", () => {
    // The whole point of `raw()`: falling back costs readability, never fidelity.
    for (const file of EXPECTED_FALLBACKS.keys()) {
      const stored = loadFixture<StackItemXdo>(`statements/${file}`);
      const ctx = new DecodeContext();
      const source = printExpr(decodeStatement(ctx, NO_REFS, stored));
      expect(normalize(encodeStatement(evaluate(source) as Statement)), file).toEqual(
        normalize(stored),
      );
    }
  });
});

// ── synthetic bundles the fixture corpus cannot express ──────────────────────

describe("codegen corpus — bundles the fixtures cannot cover", () => {
  it("round-trips an unregistered statement through raw()", async () => {
    // The R5 escape hatch: a statement Xano ships after this SDK release still
    // survives a pull, verbatim.
    const { decodeBundle } = await import("../../src/codegen/index.js");
    const unknown = {
      name: "mvp:not_a_real_statement",
      context: { whatever: true },
      input: [],
      as: "x",
      future_key: 42,
    };
    const project = decodeBundle({
      payload: {
        workspace: { name: "ws", description: "", canonical: "" },
        function: [{ name: "fn", guid: "a".repeat(32), input: [], result: [], run: [unknown] }],
      },
    });
    const source = project.files.find((file) => file.path.endsWith("fn.ts"))!.contents;
    expect(source).toContain("raw(");
    expect(source).toContain("future_key");
    const entries = project.report.entries.filter((e) => e.category === "raw-fallback");
    expect(entries).toHaveLength(1);
  });

  it("decodes the supported parts of a bundle and reports an unsupported section", async () => {
    const { decodeBundle } = await import("../../src/codegen/index.js");
    const project = decodeBundle({
      payload: {
        workspace: { name: "ws", description: "", canonical: "" },
        function: [{ name: "fn", guid: "b".repeat(32), input: [], result: [], run: [] }],
        vault: [{ name: "a-secret" }],
      },
    });
    // The supported half still comes out…
    expect(project.files.some((file) => file.path.endsWith("fn.ts"))).toBe(true);
    // …and the rest is named, not dropped in silence.
    const unsupported = project.report.entries.filter((e) => e.category === "unsupported-section");
    expect(unsupported.map((e) => e.detail).join()).toContain("payload.vault");
  });
});
