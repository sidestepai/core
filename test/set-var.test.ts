import { describe, it, expect } from "vitest";
import { setVar, updateVar, SET_VAR, UPDATE_VAR } from "../src/statements/set-var.js";
import {
  encodeStatement,
  isRegisteredStatement,
  getStatementFactory,
} from "../src/statements/statement.js";
import { c, ref, inp } from "../src/values/value.js";
import { normalize, loadFixture } from "./conformance/harness.js";

describe("setVar", () => {
  it("encodes the full persisted envelope (uniform 12-key shape)", () => {
    expect(encodeStatement(setVar("x1", c.int(123)))).toEqual({
      as: "x1",
      name: "mvp:set_var",
      _xsid: "",
      addon: [],
      input: [],
      mocks: {},
      output: { items: [], filters: [], customize: false },
      context: { value: "123", tag: "const:int", filters: [] },
      runtime: null,
      disabled: false,
      description: "",
      settings_registry: null,
    });
  });

  it("places a var reference's tag in context", () => {
    const encoded = encodeStatement(setVar("y", ref("x1")));
    expect(encoded.context).toEqual({ value: "x1", tag: "var", filters: [] });
  });

  it("places an input reference's tag in context", () => {
    const encoded = encodeStatement(setVar("y", inp("name")));
    expect(encoded.context).toEqual({ value: "name", tag: "input", filters: [] });
  });

  it("emits the full envelope: empty input[], placeholder _xsid, default rich output", () => {
    const encoded = encodeStatement(setVar("x1", c.int(1)));
    expect(encoded.input).toEqual([]);
    expect(encoded._xsid).toBe("");
    expect(encoded.output).toEqual({ items: [], filters: [], customize: false });
  });
});

describe("updateVar", () => {
  it("encodes byte-equal to the update_var golden fixture", () => {
    const fixture = loadFixture("statements/update_var.json");
    expect(normalize(encodeStatement(updateVar("x1", c.int(123))))).toEqual(normalize(fixture));
  });

  it("names the target variable in context.name (top-level as stays empty)", () => {
    const encoded = encodeStatement(updateVar("counter", ref("total")));
    expect(encoded.context).toEqual({ name: "counter", value: "total", tag: "var", filters: [] });
    expect(encoded.as).toBe("");
  });

  it("normalizes its lean output to the full rich form", () => {
    const encoded = encodeStatement(updateVar("x1", c.int(1)));
    expect(encoded.output).toEqual({ items: [], filters: [], customize: false });
    expect(encoded.input).toEqual([]);
  });
});

describe("statement registry", () => {
  it("resolves the set_var factory by name", () => {
    expect(isRegisteredStatement(SET_VAR)).toBe(true);
    expect(getStatementFactory(SET_VAR)).toBe(setVar);
  });

  it("resolves the update_var factory by name", () => {
    expect(isRegisteredStatement(UPDATE_VAR)).toBe(true);
    expect(getStatementFactory(UPDATE_VAR)).toBe(updateVar);
  });

  it("throws a clear error for an unknown statement name", () => {
    expect(() => getStatementFactory("mvp:does_not_exist")).toThrow(/Unknown statement/);
  });

  it("encodeStatement rejects an unregistered statement", () => {
    expect(() =>
      encodeStatement({ name: "mvp:nope", context: {}, input: [] }),
    ).toThrow(/unregistered statement/);
  });
});
