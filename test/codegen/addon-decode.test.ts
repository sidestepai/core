/**
 * Addon decode — `context` back into the authoring surface.
 *
 * An addon persists as a single `context` blob, so a verbatim passthrough is
 * exact but unreadable: a pulled addon arrives as ~60 lines of engine defaults
 * with its table binding buried as a guid. `addonEntries` lifts each surface it
 * can rebuild (`table`, `where`, `sort`, `cardinality`, `output`) back out.
 *
 * Round-trip equality is the floor, not the point — a raw passthrough already
 * round-trips. So each case asserts the *emitted source* as well, since that is
 * the only place the difference is visible.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Side-effect import: every kind registers itself on load, and `workspace()`
// encodes its config eagerly — so a test that pulls in only `table`/`addon`
// fails at construction with "Unknown object kind".
import "../../src/index.js";
import { normalize } from "../../src/validate/normalize.js";
import { decodeBundle } from "../../src/codegen/index.js";
import type { DecodeReport } from "../../src/codegen/report.js";
import { workspace } from "../../src/workspace/xano.js";
import { addon } from "../../src/kinds/addon.js";
import { table } from "../../src/kinds/table.js";
import { query } from "../../src/kinds/query.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { s } from "../../src/statements/s.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { f } from "../../src/fields/catalog.js";
import { input } from "../../src/inputs/input.js";
import { col, inp } from "../../src/values/value.js";
import { expr } from "../../src/statements/expression.js";
import type { Bundle } from "../../src/workspace/export.js";

const OUT_ROOT = fileURLToPath(new URL("../.generated-addon/", import.meta.url));

const users = table({
  name: "user",
  guid: "a".repeat(32),
  schema: { id: f.int(), name: f.text(), email: f.email() },
});

/** Decode a bundle, write the tree, re-import its barrel, and export again. */
async function regenerate(source: Bundle, name: string): Promise<Bundle> {
  const root = join(OUT_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  for (const file of decodeBundle(source).files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
  }
  const mod = (await import(/* @vite-ignore */ join(root, "index.ts"))) as {
    default: { export(): Bundle };
  };
  return mod.default.export();
}

/** Build a one-addon workspace and return its bundle, the addon's source, and the decode report. */
function build(def: Parameters<typeof addon>[0]): {
  bundle: Bundle;
  source: string;
  report: DecodeReport;
} {
  const ws = workspace("w").registerTables([users]).registerAddons([addon(def)]);
  const bundle = ws.export();
  const decoded = decodeBundle(bundle);
  const file = decoded.files.find((x) => x.path.includes("addon"));
  expect(file, "no generated addon file").toBeDefined();
  return { bundle, source: file!.contents, report: decoded.report };
}

afterAll(() => rmSync(OUT_ROOT, { recursive: true, force: true }));

describe("addon decode — authoring surfaces are lifted out of `context`", () => {
  let source: string;
  let bundle: Bundle;

  beforeAll(() => {
    ({ bundle, source } = build({
      name: "author",
      table: users,
      input: { user_id: input.int({ required: true }) },
      where: expr(col("id"), "=", inp("user_id")),
      output: ["id", "name"],
      cardinality: "single",
    }));
  });

  it("binds the table by symbol rather than a guid buried in `context.dbo`", () => {
    expect(source).toContain("table: user");
    expect(source).not.toContain('dbo: {');
  });

  it("recovers `where` as an expression, not a stored search tree", () => {
    expect(source).toContain("where: expr(");
    expect(source).not.toContain("search:");
  });

  it("recovers `output` as a column list", () => {
    expect(source).toContain('output: [\n    "id",\n    "name",\n  ]');
    expect(source).not.toContain("customize");
  });

  it("recovers `cardinality` rather than a `return` block", () => {
    expect(source).toContain('cardinality: "single"');
  });

  it("carries the input map through", () => {
    expect(source).toContain("user_id: input.int(");
  });

  it("emits no `context` block at all when every surface was lifted", () => {
    expect(source).not.toContain("context:");
  });

  it("re-exports byte-equal to the source bundle", async () => {
    const again = await regenerate(bundle, "full");
    expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
  });
});

describe("addon decode — surfaces that have no authoring form stay in `context`", () => {
  it("lifts a populated `dbo.as` alias to `tableAlias:` alongside `table:`", async () => {
    // The alias has its own authoring surface, so an aliased binding lifts whole.
    // This is the ordinary engine-authored shape — Xano writes an alias on every
    // addon it creates — so a passthrough here would be the common case, not the
    // exception.
    const { bundle, source } = build({
      name: "aliased",
      context: { dbo: { as: "u", id: "a".repeat(32) } },
      output: ["id"],
    });
    expect(source).toContain("table: user");
    expect(source).toContain('tableAlias: "u"');
    expect(source).not.toContain("context:");
    const again = await regenerate(bundle, "aliased");
    expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
  });

  it("keeps the alias when the bound table is gone, as `table: null` + `tableAlias`", async () => {
    // Deleting a table clears the id and leaves the alias standing, so this is a
    // real stored state and the commoner spelling of "unbound" — it must report
    // as broken like `{as:"", id:""}` does, not slip through as a raw blob.
    const { bundle, source, report } = build({
      name: "orphaned",
      context: { dbo: { as: "ledger", id: "" } },
    });
    expect(source).toContain("table: null");
    expect(source).toContain('tableAlias: "ledger"');
    expect(source).not.toContain("context:");
    expect(report.entries.map((e) => e.detail).join("\n")).toContain("bound to no table");
    const again = await regenerate(bundle, "orphaned");
    expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
  });

  it("reports an empty binding as `table: null` rather than a raw dbo blob", async () => {
    // `{as:"", id:""}` is the engine's unbound binding — an addon whose table was
    // deleted, or one that never had one. Those are the same bytes, so `null`
    // means "unbound", not "was deleted".
    const { bundle, source } = build({ name: "unbound", context: { dbo: { as: "", id: "" } } });
    expect(source).toContain("table: null");
    expect(source).not.toContain("context:");
    expect(source).not.toContain("dbo");
    const again = await regenerate(bundle, "unbound");
    expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
  });

  it("round-trips `table: null` authored directly", async () => {
    const { bundle, source } = build({ name: "explicit_null", table: null });
    expect(source).toContain("table: null");
    const again = await regenerate(bundle, "explicit-null");
    expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
    // The empty binding is what actually lands on the wire.
    const stored = (bundle.payload.addon as Array<{ context?: { dbo?: unknown } }>)[0];
    expect(stored!.context!.dbo).toEqual({ as: "", id: "" });
  });

  it("omits `table` entirely when the source wrote no `dbo` at all", () => {
    // Distinct from `null`: no binding key was persisted, so none is authored.
    const { source } = build({ name: "no_dbo", context: { bind: [{ name: "x" }] } });
    expect(source).not.toContain("table:");
  });

  it("leaves `aggregate` in `context`, since its graft comes from group/eval", () => {
    const { source } = build({
      name: "agg",
      table: users,
      context: { return: { type: "aggregate", aggregate: { sort: [], eval: [], group: [] } } },
    });
    expect(source).not.toContain('cardinality: "aggregate"');
    expect(source).toContain("context:");
  });

  it("round-trips an addon whose context it could not fully lift", async () => {
    const { bundle } = build({
      name: "aliased",
      context: { dbo: { as: "u", id: "a".repeat(32) } },
      output: ["id"],
    });
    const again = await regenerate(bundle, "aliased");
    expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
  });
});

describe("addon decode — cardinality", () => {
  for (const cardinality of ["single", "count", "exists"] as const) {
    it(`lifts ${cardinality} and still round-trips`, async () => {
      const { bundle, source } = build({ name: `c_${cardinality}`, table: users, cardinality });
      expect(source).toContain(`cardinality: "${cardinality}"`);
      const again = await regenerate(bundle, `c_${cardinality}`);
      expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
    });
  }

  it("omits the default `list` cardinality rather than restating it", () => {
    const { source } = build({ name: "c_list", table: users, cardinality: "list" });
    expect(source).not.toContain("cardinality:");
  });
});

describe("addon decode — engine-default context members", () => {
  it("drops the default envelope the engine writes even when nothing is customized", async () => {
    // An unbound addon persists the whole bind/eval/lock/return/external/
    // simpleExternal envelope at its defaults — ~60 lines that say nothing. They
    // are keyed off `normalize`'s own oracle, which already elides them on BOTH
    // sides of the comparison, so dropping them cannot change the round trip.
    const { bundle, source } = build({
      name: "bare",
      context: {
        dbo: { as: "", id: "" },
        bind: [],
        eval: [],
        sort: [],
        future: false,
        lock: { tag: "const:bool", value: "", filters: [] },
        search: { expression: [] },
      },
    });
    for (const noise of ["bind:", "eval:", "future:", "lock:", "search:"]) {
      expect(source, `${noise} is an engine default and should not be emitted`).not.toContain(noise);
    }
    const again = await regenerate(bundle, "bare");
    expect(normalize(again.payload.addon)).toEqual(normalize(bundle.payload.addon));
  });

  it("keeps a context member that was genuinely customized", () => {
    const { source } = build({
      name: "custom",
      table: users,
      context: { bind: [{ name: "x" }], future: true },
    });
    expect(source).toContain("bind:");
    expect(source).toContain("future: true");
  });
});

describe("addon decode — an unbound addon is reported, not just emitted", () => {
  it("reports the broken binding so it is visible in the pull", () => {
    // `table: null` is a defect in the source workspace, not a style choice.
    // Emitting it quietly would hide an addon that returns nothing.
    const ws = workspace("w")
      .registerTables([users])
      .registerAddons([addon({ name: "broken", table: null })]);
    const entries = decodeBundle(ws.export()).report.entries.filter(
      (e) => e.category === "empty-source",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.object).toBe("addon:broken");
    expect(entries[0]!.detail).toContain("bound to no table");
  });

  it("stays silent for an addon that is properly bound", () => {
    const ws = workspace("w")
      .registerTables([users])
      .registerAddons([addon({ name: "fine", table: users, output: ["id"] })]);
    expect(
      decodeBundle(ws.export()).report.entries.filter((e) => e.category === "empty-source"),
    ).toEqual([]);
  });
});

/**
 * An UNBOUND addon attachment (`id: ""` or `id: 0`) — the addon was deleted, or
 * never bound.
 *
 * Resolving it threw inside the factory, and a factory throw is not a local
 * failure: it degraded the whole enclosing `db.query` to `raw()`. 12 of the 17
 * factory aborts in a 187-workspace sweep were this one cause. `addon: null` is
 * the same "no target" spelling `table: null` and `fn: null` already carry.
 */
describe("unbound addon attachment", () => {
  /** A workspace with one query whose single attachment carries `id`. */
  function queryWithAttachment(id: string | number): Bundle {
    const ws = workspace("w")
      .registerTables([users])
      .registerApiGroups([apiGroup({ name: "public" })])
      .registerQueries([
        query({
          name: "list",
          verb: "GET",
          apiGroup: "public",
          stack: [s.db.query({ table: users, as: "rows" })],
        }),
      ]);
    const bundle = ws.export() as Bundle;
    // The attachment list lives at the STATEMENT's top level, not under `context`.
    const stack = (bundle.payload as unknown as { query: Array<{ run: Array<Record<string, unknown>> }> }).query[0]!.run;
    stack[0]!.addon = [
      { id, as: "_extra", input: [], output: { items: [], filters: [], customize: false }, children: [] },
    ];
    return bundle;
  }

  it("keeps the enclosing query readable instead of aborting it to raw()", () => {
    const file = decodeBundle(queryWithAttachment("")).files.find((x) => x.path.includes("queries"));
    expect(file!.contents).toContain("addon: null");
    expect(file!.contents).not.toContain("raw(");
  });

  it("reads a numeric `0` as the same absence, not as an identity", () => {
    // The other stored spelling of "no target". A numeric id that is NOT the
    // sentinel still declines — nothing here reads identity out of a number.
    const file = decodeBundle(queryWithAttachment(0)).files.find((x) => x.path.includes("queries"));
    expect(file!.contents).toContain("addon: null");
    expect(file!.contents).not.toContain("raw(");
  });

  it("reports the blank rather than presenting a lost binding as a deliberate one", () => {
    const report = decodeBundle(queryWithAttachment("")).report;
    const entry = report.entries.find((e) => e.category === "unresolved-ref");
    expect(entry?.detail).toContain("_extra");
    expect(entry?.detail).toContain("addon: null");
    // …and a bound attachment says nothing.
    const bound = decodeBundle(queryWithAttachment(deriveGuid("addon", "extra"))).report;
    expect(bound.entries.some((e) => e.detail.includes("blank addon reference"))).toBe(false);
  });

  it("names the one cause a blank reference can have, with no hedge", () => {
    // This flow pulls whole workspaces, so a blank reference cannot be a live
    // target that merely sat outside a scoped export. The line used to offer
    // that reading and tell the reader to re-pull with the addon in scope —
    // advice about a situation this SDK cannot produce.
    const detail =
      decodeBundle(queryWithAttachment("")).report.entries.find(
        (e) => e.category === "unresolved-ref",
      )?.detail ?? "";
    expect(detail).toContain("deleted, or the binding was never made");
    expect(detail).not.toContain("re-pull");
    expect(detail).not.toContain("scope");
  });

  it("still resolves an attachment that names a real addon", () => {
    // The paired negative: `null` appears only for a genuinely blank id.
    const bound = queryWithAttachment(deriveGuid("addon", "extra"));
    const file = decodeBundle(bound).files.find((x) => x.path.includes("queries"));
    expect(file!.contents).not.toContain("addon: null");
  });
});
