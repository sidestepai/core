/**
 * Addon-authoring encoder (`encodeAddons`) emit-shape proof.
 *
 * The stored shape is grounded in the cloud-client `addon-complex` script2json
 * golden (`.../parser/script2json/minimal/addon-complex.json`) plus the export
 * transform (`Migrate::exportAddonImpls`: numeric `id` -> guid, recurse on
 * `children`). The vendored `db_view_addon.json` fixture is that golden's addon
 * block with `id` in export form (guid), which is what the SDK emits into a
 * packageExport bundle.
 */
import { describe, it, expect } from "vitest";
import { encodeAddons } from "../../src/statements/special/addon-encode.js";
import type { AddonSpec } from "../../src/statements/special/addon-encode.js";
import { deriveGuid } from "../../src/refs/guid.js";
import { out, env } from "../../src/values/value.js";
import { loadFixture } from "../conformance/harness.js";

const golden = loadFixture("statements/db_view_addon.json") as { addon: unknown[] };

describe("encodeAddons", () => {
  it("encodes a nested addon byte-for-byte to the export-form golden", () => {
    // Mirrors the addon-complex golden: a `transaction` addon at `items._book`
    // with one parent-row input + two output cols, nesting a second `transaction`
    // at `obj._book2222`. Nested input uses a `setting`-tagged value to match the
    // golden's `$env.API_KEY` -> tag:"setting" leaf.
    const specs: AddonSpec[] = [
      {
        addon: "transaction",
        as: "items._book",
        input: { book_id: out("book_name") },
        output: ["name", "name2"],
        children: [
          {
            addon: "transaction",
            as: "obj._book2222",
            input: { book_id: { tag: "setting", value: "API_KEY", filters: [] } },
            output: ["name", "name2"],
          },
        ],
      },
    ];
    expect(encodeAddons(specs)).toEqual(golden.addon);
  });

  it("splits a dotted `as` at the last dot into offset + as", () => {
    const a = encodeAddons([{ addon: "transaction", as: "items._book" }])[0]!;
    expect(a).toMatchObject({ offset: "items", as: "_book" });
  });

  it("splits a multi-segment `as` at the LAST dot (nested offset)", () => {
    const a = encodeAddons([{ addon: "transaction", as: "items.book._author" }])[0]!;
    expect(a).toMatchObject({ offset: "items.book", as: "_author" });
  });

  it("throws on a degenerate `as` (empty, leading dot, or trailing dot)", () => {
    expect(() => encodeAddons([{ addon: "transaction", as: "" }])).toThrow(/non-empty destination/);
    expect(() => encodeAddons([{ addon: "transaction", as: ".book" }])).toThrow(/empty offset or alias/);
    expect(() => encodeAddons([{ addon: "transaction", as: "book." }])).toThrow(/empty offset or alias/);
  });

  it("omits `offset` when `as` has no dot", () => {
    const a = encodeAddons([{ addon: "transaction", as: "_book" }])[0]!;
    expect(a).not.toHaveProperty("offset");
    expect(a).toMatchObject({ as: "_book" });
  });

  it("omits `output` when no columns are given", () => {
    const a = encodeAddons([{ addon: "transaction", as: "_book" }])[0]!;
    expect(a).not.toHaveProperty("output");
  });

  it("emits the addon `output` block WITHOUT a `filters` key (O1)", () => {
    const a = encodeAddons([{ addon: "transaction", as: "_book", output: ["name"] }])[0]!;
    expect(a.output).toEqual({ customize: true, items: [{ name: "name", children: [] }] });
    expect(a.output).not.toHaveProperty("filters");
  });

  it("emits a lean empty `input: []` when no inputs are given", () => {
    const a = encodeAddons([{ addon: "transaction", as: "_book" }])[0]!;
    expect(a.input).toEqual([]);
  });

  it("passes an input value's tag through unchanged (out -> output, env -> env)", () => {
    const a = encodeAddons([
      { addon: "transaction", as: "_book", input: { a: out("x"), b: env("K") } },
    ])[0]!;
    expect(a.input).toEqual([
      { name: "a", tag: "output", value: "x", filters: [] },
      { name: "b", tag: "env", value: "K", filters: [] },
    ]);
  });

  it("resolves a bare name to deriveGuid('addon', name) as the `id`", () => {
    const a = encodeAddons([{ addon: "orders", as: "_o" }])[0]!;
    expect(a.id).toBe(deriveGuid("addon", "orders"));
  });

  it("uses a def handle's explicit guid verbatim as the `id`", () => {
    const a = encodeAddons([{ addon: { name: "orders", guid: "abc123" }, as: "_o" }])[0]!;
    expect(a.id).toBe("abc123");
  });

  it("throws on a self-referential `children` cycle instead of overflowing the stack", () => {
    const cyclic: AddonSpec = { addon: "transaction", as: "_book" };
    cyclic.children = [cyclic];
    expect(() => encodeAddons([cyclic])).toThrow(/cycle detected/);
  });

  it("returns [] for an omitted or empty addon list", () => {
    expect(encodeAddons()).toEqual([]);
    expect(encodeAddons([])).toEqual([]);
  });

  it("preserves order across multiple addons", () => {
    const ids = encodeAddons([
      { addon: "a", as: "_a" },
      { addon: "b", as: "_b" },
    ]).map((x) => x.id);
    expect(ids).toEqual([deriveGuid("addon", "a"), deriveGuid("addon", "b")]);
  });
});
