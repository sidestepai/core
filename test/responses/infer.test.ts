import { describe, it, expect, expectTypeOf } from "vitest";
import { query, encodeQuery } from "../../src/kinds/query.js";
import { defineFunction } from "../../src/function/define.js";
import { apiGroup } from "../../src/kinds/api-group.js";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import { ref, c, withFilters } from "../../src/values/value.js";
import { fl } from "../../src/values/generated/filters.generated.js";
import { s } from "../../src/statements/s.js";
import type { InferResponse } from "../../src/responses/infer.js";
import type { InferRow } from "../../src/kinds/table.js";

/**
 * Issue #5 — `InferResponse<typeof query>` is the read-side round-trip
 * counterpart of `InferInput`. These are compile-time assertions (validated by
 * `tsc`, which includes `test/`); the `@ts-expect-error` cases prove the produced
 * type is real.
 *
 * U1 covers the always-correct override path (`responseShape`) and the `unknown`
 * fallback. Auto-derivation (object-literal keys, single-var trace) is U2/U5.
 */

const links = apiGroup({ name: "links", canonical: "abc123" });

const link = table({
  name: "link",
  schema: {
    slug: f.text({ required: true }),
    url: f.text({ required: true }),
    clicks: f.int(),
  },
});

// A table with a nested object column — exercises a *multi-segment* dotted ref
// (`row.meta.title`), which walks the recursive `IndexShape`/`IndexStep` branch
// rather than the single-segment base case (#105).
const linkWithMeta = table({
  name: "link_with_meta",
  schema: {
    meta: f.object({ title: f.text({ required: true }) }, { required: true }),
  },
});

// A declared list response — the link-shortener pattern.
const listLinks = query({
  verb: "GET",
  apiGroup: links,
  name: "list_links",
  stack: [],
  response: ref("rows"),
  responseShape: [] as InferRow<typeof link>[],
});

// A declared nullable response — the snippet-pastebin get() pattern.
const getLink = query({
  verb: "GET",
  apiGroup: links,
  name: "get_link",
  input: {},
  response: ref("row"),
  responseShape: null as InferRow<typeof link> | null,
});

// No declaration and no derivable shape yet (U1) → unknown.
const undeclared = query({
  verb: "GET",
  apiGroup: links,
  name: "undeclared",
  response: ref("x"),
});

// An object-literal response — keys statically known (U2), values unknown until
// the single-var trace (U5).
const objectResponse = query({
  verb: "GET",
  apiGroup: links,
  name: "object_response",
  response: { id: ref("row"), label: ref("row") },
});

// A record response mixing a traced ref with a nested plain object member
// (#133) — keys stay statically known; the nested object resolves to `unknown`
// (same as wrapping it in obj(...) by hand did before).
const nestedObjectResponse = query({
  verb: "GET",
  apiGroup: links,
  name: "nested_object_response",
  response: { user: { id: ref("row"), age: 3 }, label: ref("row") },
});

// A single-variable response with no override and no trace yet → unknown (U5
// turns this into the traced row shape).
const singleVar = query({
  verb: "GET",
  apiGroup: links,
  name: "single_var",
  stack: [],
  response: ref("row"),
});

// A function carrying a declared response (parity with queries).
const computeStats = defineFunction({
  name: "compute_stats",
  input: {},
  responseShape: { total: 0 } as { total: number },
});

describe("InferResponse (type-level)", () => {
  it("declared list responseShape → InferRow<typeof link>[]", () => {
    expectTypeOf<InferResponse<typeof listLinks>>().toEqualTypeOf<InferRow<typeof link>[]>();
  });

  it("declared nullable responseShape preserves `| null`", () => {
    expectTypeOf<InferResponse<typeof getLink>>().toEqualTypeOf<
      InferRow<typeof link> | null
    >();
  });

  it("undeclared, non-derivable response → unknown (U1 fallback)", () => {
    expectTypeOf<InferResponse<typeof undeclared>>().toEqualTypeOf<unknown>();
  });

  it("object-literal response → keys known, values unknown (U2)", () => {
    expectTypeOf<InferResponse<typeof objectResponse>>().toEqualTypeOf<{
      id: unknown;
      label: unknown;
    }>();
  });

  it("nested-object response member → keys known, nested value unknown (#133)", () => {
    expectTypeOf<InferResponse<typeof nestedObjectResponse>>().toEqualTypeOf<{
      user: unknown;
      label: unknown;
    }>();
  });

  it("a key absent from the response record is rejected", () => {
    const r: InferResponse<typeof objectResponse> = { id: 1, label: "x" };
    // @ts-expect-error — `missing` is not a declared response key
    void r.missing;
    void r;
  });

  it("single-variable response with an empty/absent stack → unknown", () => {
    expectTypeOf<InferResponse<typeof singleVar>>().toEqualTypeOf<unknown>();
  });
});

// U5 — the single-variable trace against the branded stack. These are the
// headline testbed patterns that previously required hand-asserted return types.
const listLinksTraced = query({
  verb: "GET",
  apiGroup: links,
  name: "list_links_traced",
  stack: [s.db.query({ table: link, as: "rows" })],
  response: ref("rows"),
});

const getLinkTraced = query({
  verb: "GET",
  apiGroup: links,
  name: "get_link_traced",
  stack: [s.db.get({ table: link, fieldValue: c.int(1), as: "row" })],
  response: ref("row"),
});

const getNarrowed = query({
  verb: "GET",
  apiGroup: links,
  name: "get_narrowed",
  stack: [s.db.get({ table: link, fieldValue: c.int(1), output: ["id", "slug"], as: "row" })],
  response: ref("row"),
});

const objectTraced = query({
  verb: "GET",
  apiGroup: links,
  name: "object_traced",
  stack: [s.db.get({ table: link, fieldValue: c.int(1), as: "row" })],
  response: { item: ref("row") },
});

const unresolvableRef = query({
  verb: "GET",
  apiGroup: links,
  name: "unresolvable_ref",
  stack: [s.db.get({ table: link, fieldValue: c.int(1), as: "row" })],
  response: ref("nope"),
});

const setVarResponse = query({
  verb: "GET",
  apiGroup: links,
  name: "set_var_response",
  stack: [s.set_var("computed", c.int(1))],
  response: ref("computed"),
});

describe("InferResponse — single-variable trace (U5, type-level)", () => {
  it("trace fixtures construct as named queries (runtime touch)", () => {
    const names = [
      listLinksTraced.name,
      getLinkTraced.name,
      getNarrowed.name,
      objectTraced.name,
      unresolvableRef.name,
      setVarResponse.name,
    ];
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it("list: db.query result returned → InferRow<typeof link>[]", () => {
    expectTypeOf<InferResponse<typeof listLinksTraced>>().toEqualTypeOf<
      InferRow<typeof link>[]
    >();
  });

  it("get: db.get result returned → InferRow<typeof link> | null (null-on-miss, #105)", () => {
    expectTypeOf<InferResponse<typeof getLinkTraced>>().toEqualTypeOf<
      InferRow<typeof link> | null
    >();
  });

  it("column-narrowed get → Pick of the selected columns | null (#105)", () => {
    expectTypeOf<InferResponse<typeof getNarrowed>>().toEqualTypeOf<
      Pick<InferRow<typeof link>, "id" | "slug"> | null
    >();
  });

  it("object-literal response with a traceable value resolves that key's shape (nullable for db.get, #105)", () => {
    expectTypeOf<InferResponse<typeof objectTraced>>().toEqualTypeOf<{
      item: InferRow<typeof link> | null;
    }>();
  });

  it("a ref with no matching statement → unknown", () => {
    expectTypeOf<InferResponse<typeof unresolvableRef>>().toEqualTypeOf<unknown>();
  });

  it("a ref to a set_var (unbranded) var → unknown (engine-faithful)", () => {
    expectTypeOf<InferResponse<typeof setVarResponse>>().toEqualTypeOf<unknown>();
  });

  it("a filtered response value degrades to unknown, even when its ref is traceable", () => {
    const filtered = query({
      verb: "GET",
      apiGroup: links,
      name: "filtered_resp",
      stack: [s.db.get({ table: link, fieldValue: c.int(1), as: "row" })],
      response: withFilters(ref("row"), fl.first()),
    });
    expect(filtered.name).toBe("filtered_resp");
    expectTypeOf<InferResponse<typeof filtered>>().toEqualTypeOf<unknown>();
  });

  it("in a record response, a filtered key is unknown while sibling refs still trace", () => {
    const mixed = query({
      verb: "GET",
      apiGroup: links,
      name: "mixed_resp",
      stack: [s.db.get({ table: link, fieldValue: c.int(1), as: "row" })],
      response: { raw: ref("row"), munged: withFilters(ref("row"), fl.first()) },
    });
    expect(mixed.name).toBe("mixed_resp");
    expectTypeOf<InferResponse<typeof mixed>>().toEqualTypeOf<{
      raw: InferRow<typeof link> | null;
      munged: unknown;
    }>();
  });

  it("traces the correct statement in a deeper mixed stack (recursion smoke test)", () => {
    const deep = query({
      verb: "GET",
      apiGroup: links,
      name: "deep_stack",
      stack: [
        s.set_var("a", c.int(1)),
        s.db.query({ table: link, as: "listing" }),
        s.set_var("b", c.text("x")),
        s.db.get({ table: link, fieldValue: c.int(1), output: ["id"], as: "target" }),
        s.set_var("c", c.bool(true)),
      ],
      response: ref("target"),
    });
    expect(deep.name).toBe("deep_stack");
    expectTypeOf<InferResponse<typeof deep>>().toEqualTypeOf<
      Pick<InferRow<typeof link>, "id"> | null
    >();
  });

  it("add: db.add result returned → InferRow<typeof link> (issue #48, no cast)", () => {
    const createLink = query({
      verb: "POST",
      apiGroup: links,
      name: "create_link",
      stack: [s.db.add({ table: link, row: { slug: c.text("a"), url: c.text("u") }, as: "created" })],
      response: ref("created"),
    });
    expect(createLink.name).toBe("create_link");
    expectTypeOf<InferResponse<typeof createLink>>().toEqualTypeOf<InferRow<typeof link>>();
  });

  it("edit: db.edit post-mutation result returned → InferRow<typeof link>", () => {
    const updateLink = query({
      verb: "POST",
      apiGroup: links,
      name: "update_link",
      stack: [s.db.edit({ table: link, fieldValue: c.int(1), row: { clicks: c.int(2) }, as: "updated" })],
      response: ref("updated"),
    });
    expect(updateLink.name).toBe("update_link");
    expectTypeOf<InferResponse<typeof updateLink>>().toEqualTypeOf<InferRow<typeof link>>();
  });

  it("del: db.del is unbranded (engine returns no row) → unknown", () => {
    const deleteLink = query({
      verb: "DELETE",
      apiGroup: links,
      name: "delete_link",
      stack: [s.db.del({ table: link, fieldValue: c.int(1), as: "removed" })],
      response: ref("removed"),
    });
    expect(deleteLink.name).toBe("delete_link");
    // `dbo_delby` declares no output schema and its `process()` returns nothing,
    // so the `as` var holds `null`; the honest derived type is `unknown`.
    expectTypeOf<InferResponse<typeof deleteLink>>().toEqualTypeOf<unknown>();
  });

  it("patch: db.patch post-patch result returned → InferRow<typeof link>", () => {
    const patchLink = query({
      verb: "POST",
      apiGroup: links,
      name: "patch_link",
      stack: [s.db.patch({ table: link, fieldValue: c.int(1), data: c.obj({}), as: "patched" })],
      response: ref("patched"),
    });
    expect(patchLink.name).toBe("patch_link");
    expectTypeOf<InferResponse<typeof patchLink>>().toEqualTypeOf<InferRow<typeof link>>();
  });

  it("add_or_edit: db.add_or_edit upserted result returned → InferRow<typeof link>", () => {
    const upsertLink = query({
      verb: "POST",
      apiGroup: links,
      name: "upsert_link",
      stack: [s.db.add_or_edit({ table: link, fieldValue: c.int(1), row: { slug: c.text("a") }, as: "upserted" })],
      response: ref("upserted"),
    });
    expect(upsertLink.name).toBe("upsert_link");
    expectTypeOf<InferResponse<typeof upsertLink>>().toEqualTypeOf<InferRow<typeof link>>();
  });

  it("has: db.has existence result returned → boolean", () => {
    const hasLink = query({
      verb: "GET",
      apiGroup: links,
      name: "has_link",
      stack: [s.db.has({ table: link, fieldValue: c.int(1), as: "exists" })],
      response: ref("exists"),
    });
    expect(hasLink.name).toBe("has_link");
    expectTypeOf<InferResponse<typeof hasLink>>().toEqualTypeOf<boolean>();
  });

  it("bulk.patch → row list, bulk.delete → count number", () => {
    const bulkPatchLinks = query({
      verb: "POST",
      apiGroup: links,
      name: "bulk_patch_links",
      stack: [s.db.bulk.patch({ table: link, items: c.array([]), as: "patched" })],
      response: ref("patched"),
    });
    const bulkDeleteLinks = query({
      verb: "DELETE",
      apiGroup: links,
      name: "bulk_delete_links",
      stack: [s.db.bulk.delete({ table: link, as: "count" })],
      response: ref("count"),
    });
    expect([bulkPatchLinks.name, bulkDeleteLinks.name].every((n) => n.length > 0)).toBe(true);
    expectTypeOf<InferResponse<typeof bulkPatchLinks>>().toEqualTypeOf<InferRow<typeof link>[]>();
    expectTypeOf<InferResponse<typeof bulkDeleteLinks>>().toEqualTypeOf<number>();
  });

  it("bulk.add/bulk.update return unknown (engine declares no output schema)", () => {
    const bulkAddLinks = query({
      verb: "POST",
      apiGroup: links,
      name: "bulk_add_links",
      stack: [s.db.bulk.add({ table: link, items: c.array([]), as: "added" })],
      response: ref("added"),
    });
    expect(bulkAddLinks.name).toBe("bulk_add_links");
    expectTypeOf<InferResponse<typeof bulkAddLinks>>().toEqualTypeOf<unknown>();
  });

  it("a dotted ref projects a column out of a traced db row, carrying db.get's null (#93/#105)", () => {
    const slugOf = query({
      verb: "GET",
      apiGroup: links,
      name: "slug_of",
      stack: [s.db.get({ table: link, fieldValue: c.int(1), as: "row" })],
      response: ref("row.slug"),
    });
    expect(slugOf.name).toBe("slug_of");
    // `db.get` binds `Row | null`; `$row.slug` on a missed row is itself null.
    expectTypeOf<InferResponse<typeof slugOf>>().toEqualTypeOf<string | null>();
  });

  it("a multi-segment dotted ref re-distributes db.get's null at each level (#105)", () => {
    // `row.meta.title` is two indexing steps: the recursive `IndexShape` branch
    // (not the single-segment base case `row.slug` above) must carry the
    // top-level `| null` through to the leaf — a regression that recursed into
    // the non-null `IndexStep` instead would drop it and this alone would catch it.
    const titleOf = query({
      verb: "GET",
      apiGroup: links,
      name: "title_of",
      stack: [s.db.get({ table: linkWithMeta, fieldValue: c.int(1), as: "row" })],
      response: ref("row.meta.title"),
    });
    expect(titleOf.name).toBe("title_of");
    expectTypeOf<InferResponse<typeof titleOf>>().toEqualTypeOf<string | null>();
  });

  it("a dotted ref into an untraceable (set_var) base stays unknown", () => {
    const dottedSetVar = query({
      verb: "GET",
      apiGroup: links,
      name: "dotted_set_var",
      stack: [s.set_var("computed", c.int(1))],
      response: ref("computed.whatever"),
    });
    expect(dottedSetVar.name).toBe("dotted_set_var");
    expectTypeOf<InferResponse<typeof dottedSetVar>>().toEqualTypeOf<unknown>();
  });

  it("defineFunction carries a declared responseShape identically", () => {
    expectTypeOf<InferResponse<typeof computeStats>>().toEqualTypeOf<{ total: number }>();
  });

  it("a mismatched value is rejected against the declared response type", () => {
    const rows: InferResponse<typeof listLinks> = [
      { id: 1, created_at: 0, slug: "a", url: "u", clicks: 0 },
    ];
    void rows;
    // @ts-expect-error — a bare object is not the declared array response
    const wrong: InferResponse<typeof listLinks> = { nope: true };
    void wrong;
  });

  it("encodeQuery ignores responseShape — no such key in the encoded xdo", () => {
    const xdo = encodeQuery(listLinks) as unknown as Record<string, unknown>;
    expect("responseShape" in xdo).toBe(false);
    // The declared list endpoint still encodes its response assignment.
    expect(Array.isArray(xdo.result)).toBe(true);
  });

  it("all fixtures construct as named queries/functions (runtime touch)", () => {
    const names = [
      getLink.name,
      undeclared.name,
      objectResponse.name,
      nestedObjectResponse.name,
      singleVar.name,
    ];
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(computeStats.name).toBe("compute_stats");
  });
});
