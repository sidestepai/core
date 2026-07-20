import { describe, it, expect, expectTypeOf } from "vitest";
import { c, ref, inp, filter, withFilters } from "../src/values/value.js";
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
