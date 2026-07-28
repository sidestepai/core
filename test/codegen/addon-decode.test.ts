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
import { workspace } from "../../src/workspace/xano.js";
import { addon } from "../../src/kinds/addon.js";
import { table } from "../../src/kinds/table.js";
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

/** Build a one-addon workspace and return both its bundle and the addon's source. */
function build(def: Parameters<typeof addon>[0]): { bundle: Bundle; source: string } {
  const ws = workspace("w").registerTables([users]).registerAddons([addon(def)]);
  const bundle = ws.export();
  const file = decodeBundle(bundle).files.find((x) => x.path.includes("addon"));
  expect(file, "no generated addon file").toBeDefined();
  return { bundle, source: file!.contents };
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
  it("keeps a populated `dbo.as` alias as a passthrough, since `table:` cannot express it", () => {
    // `buildContext` writes `{id}` with no alias, so lifting an aliased binding
    // to `table:` would silently drop the alias.
    const { source } = build({
      name: "aliased",
      context: { dbo: { as: "u", id: "a".repeat(32) } },
      output: ["id"],
    });
    expect(source).toContain("context:");
    expect(source).toContain('as: "u"');
    expect(source).not.toContain("table: user");
  });

  it("does not bind a table when the stored binding is empty", () => {
    // An unbound addon stores `{as:"", id:""}`. Emitting `table:` for it would be
    // a hard failure, not a readability loss — `resolveRef` rejects a target with
    // neither a name nor a guid.
    const { source } = build({ name: "unbound", context: { dbo: { as: "", id: "" } } });
    expect(source).not.toContain("table:");
    expect(source).toContain("context:");
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
