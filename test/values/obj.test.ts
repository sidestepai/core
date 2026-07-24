import { describe, it, expect } from "vitest";
import { obj } from "../../src/values/obj.js";
import { c, inp, ref, auth, col, withFilters, filter } from "../../src/values/value.js";

describe("obj() — dynamic object value (const:expr2)", () => {
  it("emits tag const:expr2 with a XanoScript object-literal string", () => {
    const v = obj({ id: inp("id"), name: c.text("Bob") });
    expect(v.tag).toBe("const:expr2");
    expect(v.filters).toEqual([]);
    expect(v.value).toBe('{ id: $input.id, name: "Bob" }');
  });

  it("renders each value tag to its XanoScript namespace", () => {
    const v = obj({
      i: inp("q"),
      r: ref("user"),
      a: auth("id"),
      whole: auth(),
      d: col("email"),
    });
    expect(v.value).toBe('{ i: $input.q, r: $var.user, a: $auth.id, whole: $auth, d: $db.email }');
  });

  it("renders constant scalars as literals", () => {
    const v = obj({ s: c.text("hi"), n: c.int(5), f: c.decimal(1.5), b: c.bool(true), z: c.null() });
    expect(v.value).toBe('{ s: "hi", n: 5, f: 1.5, b: true, z: null }');
  });

  it("escapes string constants", () => {
    const v = obj({ msg: c.text('a "quote" and \\ slash') });
    // JSON-style escaping produces valid XanoScript string literals.
    expect(v.value).toBe('{ msg: "a \\"quote\\" and \\\\ slash" }');
  });

  it("supports nested records and arrays of values", () => {
    const v = obj({ user: { id: inp("id") }, tags: [c.text("a"), ref("t")] });
    expect(v.value).toBe('{ user: { id: $input.id }, tags: ["a", $var.t] }');
  });

  it("empty object renders {}", () => {
    expect(obj({}).value).toBe("{}");
  });

  it("rejects a value carrying a filter chain", () => {
    expect(() => obj({ x: withFilters(inp("q"), filter("trim")) })).toThrow(/filter chain/);
  });

  it("rejects an unsupported value tag (env) with a clear message", () => {
    // env() is a real value but its object-literal rendering is deferred.
    const envVal = { value: "STRIPE", tag: "env" as const, filters: [] };
    expect(() => obj({ k: envVal })).toThrow(/tag "env".*isn't supported/);
  });

  it("rejects a non-identifier key", () => {
    expect(() => obj({ "not-ident": inp("x") })).toThrow(/bare identifier/);
  });

  it("coerces raw scalar members to their constant fragments", () => {
    // Raw scalars just work (#133) — same rendering as c.int/c.text/c.bool.
    expect(obj({ n: 3, greeting: "hi", ok: true }).value).toBe(
      '{ n: 3, greeting: "hi", ok: true }',
    );
    expect(obj({ rate: 1.5 }).value).toBe("{ rate: 1.5 }");
  });

  it("rejects a genuinely unsupported member (function/symbol)", () => {
    // @ts-expect-error - a function isn't a valid member
    expect(() => obj({ x: () => 1 })).toThrow(/must be a Value/);
  });
});
