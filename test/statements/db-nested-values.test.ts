/**
 * R-C — the two nested shapes a db op stores, and the authoring surfaces that
 * reproduce them.
 *
 * Both were characterized against real workspaces before being designed, and the
 * counts in each case are what a full sweep measured, so a regression here reads
 * as "this many real statements just lost their readable form":
 *
 *   • an expanded input entry (`expand:true` + `children[]`) — 14 row writes,
 *     7 on `db.add` and 7 on `db.edit`. Every one carries children (the flag is
 *     never set alone), never an `ignore` or a filter on the expanded entry, and
 *     its own value is an empty constant on 13 of 14 — the fourteenth holds a
 *     reference to the object the children were derived from, which is why the
 *     entry's value stays authored rather than derived.
 *
 *   • a nested output selection (`items[].children[]`) — 40 blocks: 11 on
 *     `db.get`, 4 on a query, and 25 inside an addon's own output. Nodes carry
 *     nothing but `name` and `children`, top-level names are unique, and no name
 *     contains a dot — which is what makes the flat dotted-path surface exactly
 *     isomorphic to the stored tree.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register kinds + statements
import { dbAdd, dbEdit, dbGet } from "../../src/statements/special/db.js";
import { encodeAddons } from "../../src/statements/special/addon-encode.js";
import { encodeOutputItems, outputPaths } from "../../src/statements/special/output-select.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { c, inp, ref } from "../../src/values/value.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";

const T = { name: "t" };
const A = { name: "author" };

/** The stored `input[]` of an encoded db op. */
function inputOf(statement: ReturnType<typeof encodeStatement>): Array<Record<string, unknown>> {
  return (statement as unknown as { input: Array<Record<string, unknown>> }).input;
}

/** The stored `output` block of an encoded db op. */
function outputOf(statement: ReturnType<typeof encodeStatement>): Record<string, unknown> {
  return (statement as unknown as { output: Record<string, unknown> }).output;
}

describe("expanded row entries", () => {
  it("writes children as full entries and derives `expand` from having them", () => {
    // `expand` is never authored: the only combinations that exist in the wild
    // are "expanded, with children" and "not expanded, without". Deriving it is
    // what keeps the two from disagreeing.
    const stored = inputOf(
      encodeStatement(
        dbEdit({
          table: T,
          fieldValue: inp("id"),
          data: [
            { name: "email", value: inp("email") },
            {
              name: "magic_link",
              value: ref("user.magic_link"),
              children: [
                { name: "token", value: ref("user.magic_link.token") },
                { name: "used", value: c.bool(true) },
              ],
            },
          ],
        }),
      ),
    );
    const flat = stored.find((e) => e.name === "email")!;
    expect(flat.expand).toBe(false);
    expect(flat.children).toEqual([]);

    const expanded = stored.find((e) => e.name === "magic_link")!;
    expect(expanded.expand).toBe(true);
    // The entry keeps its own value — the fourteenth real entry is exactly this
    // shape, and deriving the value away would make it unreproducible.
    expect(expanded.value).toBe("user.magic_link");
    expect(expanded.tag).toBe("var");
    expect(expanded.children).toEqual([
      {
        name: "token",
        value: "user.magic_link.token",
        tag: "var",
        filters: [],
        ignore: false,
        expand: false,
        children: [],
      },
      {
        name: "used",
        value: "true",
        tag: "const:bool",
        filters: [],
        ignore: false,
        expand: false,
        children: [],
      },
    ]);
  });

  it("nests to any depth, since nothing in the stored shape bounds it", () => {
    const stored = inputOf(
      encodeStatement(
        dbAdd({
          table: T,
          data: [
            {
              name: "meta",
              value: c.text(""),
              children: [
                { name: "inner", value: c.text(""), children: [{ name: "leaf", value: c.int(1) }] },
              ],
            },
          ],
        }),
      ),
    );
    const inner = (stored[0]!.children as Array<Record<string, unknown>>)[0]!;
    expect(inner.expand).toBe(true);
    expect((inner.children as Array<Record<string, unknown>>)[0]!.name).toBe("leaf");
  });

  it("expands a nested `row:` object into the same entry, with an empty-constant value", () => {
    // The `row:` sugar covers the 13-of-14 shape whose expanded entry holds an
    // empty constant. The fourteenth (a reference value) needs `data:`, which is
    // the documented escape hatch for exactly this reason.
    const users = table({
      name: "users",
      guid: "1".repeat(32),
      schema: { id: f.int(), magic_link: f.json() },
    });
    const stored = inputOf(
      encodeStatement(
        dbEdit({
          table: users,
          fieldValue: inp("id"),
          row: { magic_link: { token: inp("token"), used: c.bool(true) } },
        }),
      ),
    );
    const expanded = stored.find((e) => e.name === "magic_link")!;
    expect(expanded.expand).toBe(true);
    expect(expanded.value).toBe("");
    expect(expanded.tag).toBe("const");
    expect((expanded.children as Array<Record<string, unknown>>).map((child) => child.name)).toEqual(
      ["token", "used"],
    );
  });

  it("tells a nested cell from a value by the whole value shape, not by `tag` alone", () => {
    // The paired negative for the discriminator: a sub-key may legitimately be
    // named `tag`, and testing only for that key would read the nested cell as a
    // value and drop its children.
    const users = table({
      name: "users",
      guid: "2".repeat(32),
      schema: { id: f.int(), meta: f.json() },
    });
    const stored = inputOf(
      encodeStatement(
        dbEdit({
          table: users,
          fieldValue: inp("id"),
          row: { meta: { tag: c.text("release"), value: c.int(2) } },
        }),
      ),
    );
    const expanded = stored.find((e) => e.name === "meta")!;
    expect(expanded.expand).toBe(true);
    expect((expanded.children as Array<Record<string, unknown>>).map((child) => child.name)).toEqual(
      ["tag", "value"],
    );
  });
});

describe("nested output selection", () => {
  it("builds the stored tree from dotted paths, preserving order at every level", () => {
    expect(encodeOutputItems(["id", "password_reset.token", "password_reset.used", "email"])).toEqual(
      [
        { name: "id", children: [] },
        {
          name: "password_reset",
          children: [
            { name: "token", children: [] },
            { name: "used", children: [] },
          ],
        },
        { name: "email", children: [] },
      ],
    );
  });

  it("is exactly inverse to reading a stored tree back", () => {
    const paths = ["id", "img.url", "img.meta.width", "name"];
    expect(outputPaths(encodeOutputItems(paths))).toEqual(paths);
  });

  it("keeps an unnested selection byte-identical to what it has always been", () => {
    // The common case must not move: every existing selection is depth-1.
    expect(outputOf(encodeStatement(dbGet({ table: T, fieldValue: c.int(5), output: ["id", "email"] })))).toEqual(
      {
        customize: true,
        filters: [],
        items: [
          { name: "id", children: [] },
          { name: "email", children: [] },
        ],
      },
    );
  });

  it("nests an addon's own output the same way, without the statement's `filters` key", () => {
    const [stored] = encodeAddons([{ addon: A, as: "_author", output: ["name", "img.url"] }]) as Array<
      Record<string, unknown>
    >;
    expect(stored!.output).toEqual({
      customize: true,
      items: [
        { name: "name", children: [] },
        { name: "img", children: [{ name: "url", children: [] }] },
      ],
    });
  });

  it("rejects a path with an empty segment", () => {
    expect(() => encodeOutputItems(["img."])).toThrow(/empty path segment/);
    expect(() => encodeOutputItems([".img"])).toThrow(/empty path segment/);
    expect(() => encodeOutputItems(["img..url"])).toThrow(/empty path segment/);
  });

  it("rejects selecting a column both whole and by sub-key", () => {
    // The tree cannot hold both meanings, so accepting the pair would silently
    // drop the whole-column selection.
    expect(() => encodeOutputItems(["img", "img.url"])).toThrow(/both whole and by sub-key/);
    expect(() => encodeOutputItems(["img.url", "img"])).toThrow(/both whole and by sub-key/);
  });

  it("refuses to read back a tree the path form cannot express", () => {
    // A name carrying a dot would re-encode as two levels, so it is not
    // recoverable — the caller declines rather than emitting a lossy selection.
    expect(outputPaths([{ name: "a.b", children: [] }])).toBeNull();
    expect(outputPaths([{ name: "", children: [] }])).toBeNull();
    expect(outputPaths([{ children: [] }])).toBeNull();
    expect(outputPaths("nope")).toBeNull();
  });

  it("reads a node with no `children` key as a whole-column leaf", () => {
    expect(outputPaths([{ name: "id" }])).toEqual(["id"]);
  });
});
