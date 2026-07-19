import { describe, it, expect, expectTypeOf } from "vitest";
import { table } from "../../src/kinds/table.js";
import { f } from "../../src/fields/catalog.js";
import type { InferRow, RowOf } from "../../src/kinds/table.js";

/**
 * Issue #2 — `InferRow<typeof table>` is the read-side counterpart of
 * `InferInput`: a table's row type derived from its `FieldMap` schema brands.
 * These are compile-time assertions (validated by `tsc`, which includes
 * `test/`); the `@ts-expect-error` cases prove the produced type is real.
 */

const post = table({
  name: "post",
  schema: {
    title: f.text({ required: true }),
    slug: f.text({ required: true }),
    published: f.bool(),
    excerpt: f.text({ nullable: true }),
    tags: f.text({ array: true }),
    status: f.enum(["draft", "live"], { required: true }),
  },
});

// A table that declares its OWN id/created_at overrides the injected system
// columns (never doubled, its declared type wins).
const owned = table({
  name: "owned",
  schema: {
    id: f.uuid(),
    created_at: f.text(),
    label: f.text({ required: true }),
  },
});

// A raw ColumnDef[] schema carries no field brands → row is `unknown`.
const raw = table({ name: "raw", schema: [{ name: "x", type: "text" }] });

describe("InferRow (type-level)", () => {
  it("derives declared columns + injected system columns; all keys present", () => {
    expect(post.name).toBe("post");
    expectTypeOf<InferRow<typeof post>>().toEqualTypeOf<{
      id: number;
      created_at: number;
      title: string;
      slug: string;
      published: boolean;
      excerpt: string | null;
      tags: string[];
      status: "draft" | "live";
    }>();
  });

  it("`required` does not gate read presence — non-required columns are still present", () => {
    // Unlike InferInput, `published` (not required) is a required *key* on the row.
    expectTypeOf<InferRow<typeof post>>().toHaveProperty("published").toEqualTypeOf<boolean>();
  });

  it("declared id/created_at override the injected system columns", () => {
    expect(owned.name).toBe("owned");
    expectTypeOf<InferRow<typeof owned>>().toEqualTypeOf<{
      id: string;
      created_at: string;
      label: string;
    }>();
  });

  it("a raw ColumnDef[] schema has no brands → row is unknown", () => {
    expect(raw.name).toBe("raw");
    expectTypeOf<InferRow<typeof raw>>().toEqualTypeOf<unknown>();
  });

  it("RowOf composes directly from a FieldMap", () => {
    type R = RowOf<{ name: ReturnType<typeof f.text> }>;
    expectTypeOf<R>().toEqualTypeOf<{ id: number; created_at: number; name: string }>();
  });

  it("accepts a well-typed row, rejects wrong/missing fields", () => {
    const base = { id: 1, created_at: 0, title: "hi", slug: "hi", published: true, excerpt: null, tags: [] as string[] };
    const ok: InferRow<typeof post> = { ...base, status: "draft" };
    void ok;

    // @ts-expect-error — `status` (a required key) is missing from the row.
    const missing: InferRow<typeof post> = base;
    void missing;

    // @ts-expect-error — `status` must be one of the enum literals.
    const wrong: InferRow<typeof post> = { ...base, status: "nope" };
    void wrong;
  });
});
