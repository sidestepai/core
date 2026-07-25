import { describe, it, expect, expectTypeOf } from "vitest";
import { input, encodeInput } from "../../src/inputs/input.js";
import { f } from "../../src/fields/catalog.js";
import type { BrandValue, BrandOpts, ValueOf } from "../../src/fields/value-types.js";

/**
 * U1 — phantom value-type brands. These assert the *type-level* carriage added
 * to `input.*` / `f.*` returns, plus that the runtime object is untouched (no
 * brand keys leak into the emitted descriptor or its encoded XDO).
 */
describe("input value-type brands (type-level)", () => {
  it("scalars carry their JS value type", () => {
    expectTypeOf<BrandValue<ReturnType<typeof input.text>>>().toEqualTypeOf<string>();
    expectTypeOf<BrandValue<ReturnType<typeof input.email>>>().toEqualTypeOf<string>();
    expectTypeOf<BrandValue<ReturnType<typeof input.password>>>().toEqualTypeOf<string>();
    expectTypeOf<BrandValue<ReturnType<typeof input.uuid>>>().toEqualTypeOf<string>();
    expectTypeOf<BrandValue<ReturnType<typeof input.date>>>().toEqualTypeOf<string>();
    expectTypeOf<BrandValue<ReturnType<typeof input.int>>>().toEqualTypeOf<number>();
    expectTypeOf<BrandValue<ReturnType<typeof input.decimal>>>().toEqualTypeOf<number>();
    expectTypeOf<BrandValue<ReturnType<typeof input.timestamp>>>().toEqualTypeOf<number>();
    expectTypeOf<BrandValue<ReturnType<typeof input.bool>>>().toEqualTypeOf<boolean>();
  });

  it("enum brands a literal union of its values, not string", () => {
    const status = input.enum(["draft", "live"]);
    expect(status.options.values).toEqual(["draft", "live"]);
    expectTypeOf<BrandValue<typeof status>>().toEqualTypeOf<"draft" | "live">();
  });

  it("required flows onto the brand's captured options; absence means not-required", () => {
    const req = input.text({ required: true });
    const opt = input.text();
    expect(req.options.required).toBe(true);
    expect(opt.options.required).toBeUndefined();
    expectTypeOf<BrandOpts<typeof req>>().toMatchTypeOf<{ required: true }>();
    // A bare text input has no `required: true` in its captured options.
    expectTypeOf<BrandOpts<typeof opt> extends { required: true } ? true : false>().toEqualTypeOf<false>();
  });

  it("nullable and array modulate ValueOf", () => {
    const nul = input.text({ nullable: true });
    expect(nul.options.nullable).toBe(true);
    expectTypeOf<ValueOf<typeof nul>>().toEqualTypeOf<string | null>();

    const tags = input.list(input.text());
    expect(tags.options.array).toBe(true);
    expectTypeOf<ValueOf<typeof tags>>().toEqualTypeOf<string[]>();

    const nums = input.list(input.int(), { required: true });
    expect(nums.type).toBe("int");
    expectTypeOf<ValueOf<typeof nums>>().toEqualTypeOf<number[]>();
  });

  it("object brands a nested type from its children", () => {
    const user = input.object({ name: f.text({ required: true }), age: f.int() });
    expect(user.type).toBe("obj");
    expectTypeOf<ValueOf<typeof user>>().toEqualTypeOf<{ name: string; age?: number }>();
  });

  it("file/geo/vector/tableRef inputs carry sensible value types", () => {
    expectTypeOf<ValueOf<ReturnType<typeof input.vector>>>().toEqualTypeOf<number[]>();
    // tableRef → the referenced primary key's scalar: an int reference is a number,
    // a `{ type: "uuid" }` reference is a string (never the loose `string | number`,
    // #140). The default-options (int) path is covered in infer-row.test via a real
    // `f.tableRef("post")` column.
    expectTypeOf<
      BrandValue<ReturnType<typeof input.tableRef<{ type: "int" }>>>
    >().toEqualTypeOf<number>();
    expectTypeOf<
      BrandValue<ReturnType<typeof input.tableRef<{ type: "uuid" }>>>
    >().toEqualTypeOf<string>();
    // file inputs are an opaque resource ref (object shape), not the raw bytes.
    expectTypeOf<BrandValue<ReturnType<typeof input.image>>>().toMatchTypeOf<{ path?: string }>();
  });
});

describe("brands are phantom — runtime object unchanged", () => {
  it("input.text({ required: true }) emits exactly { type, options }", () => {
    const d = input.text({ required: true });
    expect(d).toEqual({ type: "text", options: { required: true } });
    expect(Object.keys(d)).toEqual(["type", "options"]);
  });

  it("JSON round-trip carries no brand keys", () => {
    const d = input.email({ required: true });
    expect(JSON.parse(JSON.stringify(d))).toEqual({ type: "email", options: { required: true } });
  });

  it("encodeInput output is identical to the un-branded shape", () => {
    const enc = encodeInput("email", input.email({ required: true }));
    expect(enc.type).toBe("email");
    expect(enc.required).toBe(true);
    // No `__value`/`__opts` keys leaked into the stored field.
    expect(Object.keys(enc)).not.toContain("__value");
    expect(Object.keys(enc)).not.toContain("__opts");
  });
});
