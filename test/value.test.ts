import { describe, it, expect, expectTypeOf } from "vitest";
import { c, ref, inp, auth, out, filter, withFilters } from "../src/values/value.js";
import type { Value, RefValue } from "../src/values/value.js";

describe("c.* constant constructors", () => {
  it("c.text produces a plain const", () => {
    expect(c.text("hello")).toEqual({ value: "hello", tag: "const", filters: [] });
  });

  it("c.int stringifies the number", () => {
    expect(c.int(123)).toEqual({ value: "123", tag: "const:int", filters: [] });
    expect(c.int(123).value).toBe("123");
  });

  it("c.decimal stringifies the number", () => {
    expect(c.decimal(1.5)).toEqual({ value: "1.5", tag: "const:decimal", filters: [] });
  });

  it("c.bool emits 'true'/'false' strings", () => {
    expect(c.bool(true)).toEqual({ value: "true", tag: "const:bool", filters: [] });
    expect(c.bool(false).value).toBe("false");
  });

  it("c.null emits a const:null with value 'null' (per engine fixture)", () => {
    expect(c.null()).toEqual({ value: "null", tag: "const:null", filters: [] });
  });

  it("c.obj round-trips to a parseable JSON string with const:obj", () => {
    const v = c.obj({ q: "abc" });
    expect(v.tag).toBe("const:obj");
    expect(JSON.parse(v.value)).toEqual({ q: "abc" });
  });

  it("c.array round-trips to a parseable JSON string with const:array", () => {
    const v = c.array([1, "two", true]);
    expect(v.tag).toBe("const:array");
    expect(JSON.parse(v.value)).toEqual([1, "two", true]);
  });
});

describe("c.obj/c.array reject nested tagged Values (issue #42)", () => {
  it("rejects a nested tagged Value at the type level", () => {
    // Type-only, never invoked: the @ts-expect-error markers ARE the assertions
    // (an unused directive is itself a compile error, so the typecheck fails if
    // the rejection stops firing). Invoking would throw via the U2 runtime guard,
    // so this must stay uncalled — mirrors the col()-in-a-row test (issue #32).
    function _typeOnly(): void {
      // @ts-expect-error — a bare input Value cannot be embedded in c.obj (the #42 repro)
      c.obj({ id: inp("id") });
      // @ts-expect-error — the full repro: bool + input in an object response
      c.obj({ success: c.bool(true), id: inp("id") });
      // @ts-expect-error — a Value nested one level deep is still rejected
      c.obj({ a: { b: ref("x") } });
      // @ts-expect-error — an input Value inside an array element
      c.array([inp("id")]);
      // @ts-expect-error — a Value nested inside an array-of-objects element
      c.array([{ id: auth("id") }]);
    }
    void _typeOnly;
    expect(typeof _typeOnly).toBe("function");
  });

  it("still accepts plain JSON literals (no rejection)", () => {
    expect(c.obj({ q: "abc" }).tag).toBe("const:obj");
    expect(c.obj({}).tag).toBe("const:obj");
    expect(c.obj({ a: { b: 1 }, list: [1, 2] }).tag).toBe("const:obj");
    expect(c.array([1, "two", true]).tag).toBe("const:array");
    expect(c.array([]).tag).toBe("const:array");
    // Return type is unchanged for valid input.
    expectTypeOf(c.obj({ q: "abc" })).toEqualTypeOf<Value>();
  });

  it("throws at runtime when a Value is nested (JS/any-typed bypass)", () => {
    // The compile-time type is erased for `any` callers; the guard is the backstop.
    expect(() => c.obj({ id: inp("id") } as unknown as Record<string, never>)).toThrow(
      /record of values|tagged value|response: \{/,
    );
    expect(() => c.obj({ a: { b: c.bool(true) } } as unknown as Record<string, never>)).toThrow();
    expect(() => c.array([inp("id")] as unknown as never[])).toThrow();
  });

  it("does not throw for plain JSON (preserves existing behavior)", () => {
    expect(() => c.obj({ q: "abc" })).not.toThrow();
    expect(() => c.array([1, "two", true])).not.toThrow();
    expect(() => c.obj({})).not.toThrow();
    expect(() => c.array([])).not.toThrow();
  });

  it("does not reject a plain-JSON literal that merely reuses tag/value/filters keys", () => {
    // The guard requires a *valid* Tag, matching the compile-time `extends Value`
    // check — so JSON data shaped like a Value but with an unrecognized tag is
    // fine (`"meta"` is not a Tag). This keeps the runtime guard from over-firing.
    const v = c.obj({ tag: "meta", value: "x", filters: [] });
    expect(v.tag).toBe("const:obj");
    expect(JSON.parse(v.value)).toEqual({ tag: "meta", value: "x", filters: [] });
  });
});

describe("references", () => {
  it("ref produces a var tag", () => {
    expect(ref("x1")).toEqual({ value: "x1", tag: "var", filters: [] });
  });

  it("ref carries its literal var name at the type level (U5 trace foundation)", () => {
    // The runtime value is unchanged (asserted above); only the type is branded.
    expectTypeOf(ref("user")).toEqualTypeOf<RefValue<"user">>();
    // A branded ref is still assignable wherever a plain Value is expected.
    const asValue: Value = ref("user");
    void asValue;
  });

  it("inp produces an input tag", () => {
    expect(inp("name")).toEqual({ value: "name", tag: "input", filters: [] });
  });

  it("out produces an output tag (parent-row reference for addon inputs)", () => {
    expect(out("book_name")).toEqual({ value: "book_name", tag: "output", filters: [] });
  });

  it("a dotted ref stays a raw var path by default (unchanged emit)", () => {
    // The engine resolves `$owner.user_id` in one lookup — fine when the base is
    // non-null, a 500 when it is null (issue #47). Opt into `safe` to avoid it.
    expect(ref("owner.user_id")).toEqual({ value: "owner.user_id", tag: "var", filters: [] });
  });

  it("ref({ safe: true }) compiles a nested path through the get filter (#47)", () => {
    // `owner.user_id` → `$owner|get:"user_id"` (default null): reference the base
    // var (may be null) and let `get` walk the rest, resolving to null instead of
    // raising "Unable to locate var" when the base is null.
    expect(ref("owner.user_id", { safe: true })).toEqual({
      value: "owner",
      tag: "var",
      filters: [
        {
          name: "get",
          disabled: false,
          arg: [
            { value: "user_id", tag: "const", filters: [] },
            { value: "null", tag: "const:null", filters: [] },
          ],
        },
      ],
    });
  });

  it("ref({ safe: true }) keeps the whole remaining path for a deeper dot chain", () => {
    // Split on the first dot only — `get` walks the rest ("profile.name").
    expect(ref("owner.profile.name", { safe: true })).toEqual({
      value: "owner",
      tag: "var",
      filters: [
        {
          name: "get",
          disabled: false,
          arg: [
            { value: "profile.name", tag: "const", filters: [] },
            { value: "null", tag: "const:null", filters: [] },
          ],
        },
      ],
    });
  });

  it("ref({ safe: true }) is a no-op for a plain, dot-free name", () => {
    // A bare var already resolves to null without error — no filter needed.
    expect(ref("owner", { safe: true })).toEqual({ value: "owner", tag: "var", filters: [] });
  });

  it("a safe ref stays branded as a RefValue at the type level", () => {
    expectTypeOf(ref("owner.user_id", { safe: true })).toEqualTypeOf<RefValue<"owner.user_id">>();
  });
});

describe("filters", () => {
  it("filter builds a {name, disabled, arg} entry", () => {
    expect(filter("set", c.text("q"), c.text("abc"))).toEqual({
      name: "set",
      disabled: false,
      arg: [
        { value: "q", tag: "const", filters: [] },
        { value: "abc", tag: "const", filters: [] },
      ],
    });
  });

  it("withFilters attaches a filter chain without mutating the original", () => {
    const base = c.obj({});
    const withF = withFilters(base, [filter("set", c.text("q"), c.text("abc"))]);
    expect(base.filters).toEqual([]);
    expect(withF.filters).toHaveLength(1);
    expect(withF.filters[0]).toEqual({
      name: "set",
      disabled: false,
      arg: [
        { value: "q", tag: "const", filters: [] },
        { value: "abc", tag: "const", filters: [] },
      ],
    });
  });

  it("filter() drops omitted (undefined) args instead of emitting a null", () => {
    // A typed factory calling filter("trim", undefined) must not leave a stray null.
    expect(filter("trim", undefined)).toEqual({ name: "trim", disabled: false, arg: [] });
    expect(filter("substr", c.int(1), undefined)).toEqual({
      name: "substr",
      disabled: false,
      arg: [{ value: "1", tag: "const:int", filters: [] }],
    });
  });

  it("withFilters accepts filters spread or as an array (equivalent)", () => {
    const spread = withFilters(c.text("x"), filter("trim"), filter("lower"));
    const arrayed = withFilters(c.text("x"), [filter("trim"), filter("lower")]);
    expect(spread).toEqual(arrayed);
    expect(spread.filters.map((f) => f.name)).toEqual(["trim", "lower"]);
  });
});
