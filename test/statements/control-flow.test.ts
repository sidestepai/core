import { describe, it, expect } from "vitest";
import {
  returnValue,
  die,
  debugLog,
  foreachBreak,
  foreachContinue,
  foreachRemove,
} from "../../src/statements/special/control-flow.js";
import { encodeStatement, isRegisteredStatement } from "../../src/statements/statement.js";
import { c } from "../../src/values/value.js";
import { normalize, loadFixture } from "../conformance/harness.js";

describe("control-flow special statements — validated vs persisted fixtures", () => {
  it("return deep-equals return-null fixture", () => {
    expect(normalize(encodeStatement(returnValue(c.null())))).toEqual(
      normalize(loadFixture("statements/return-null.json")),
    );
  });

  it("return accepts both a bare Value and the { value } wrapper form", () => {
    expect(returnValue(c.int(7))).toEqual(returnValue({ value: c.int(7) }));
  });

  it("return spreads a TEXT value into context the same way as the null golden", () => {
    // The worklist tracked a separate `return-null-text` golden. It does not
    // need one: `mvp:return` context is a value SPREAD, so the statement shape
    // is fixed by the null golden above and the only thing that varies is the
    // tagged value dropped into it — and a `const` text triple is pinned by its
    // own goldens elsewhere in the corpus. Asserting the composition here is
    // what a second golden of the same statement would have bought.
    const golden = loadFixture<{ context: unknown }>("statements/return-null.json");
    const encoded = encodeStatement(returnValue(c.text("hello"))) as { context: unknown };
    expect(normalize(encoded.context)).toEqual({ value: "hello", tag: "const" });
    // Same envelope as the golden — only the spread value differs.
    expect(Object.keys(normalize(encoded.context) as object)).toEqual(
      Object.keys(normalize(golden.context) as object),
    );
  });

  it("die deep-equals fixture", () => {
    expect(normalize(encodeStatement(die(c.int(123))))).toEqual(
      normalize(loadFixture("statements/die.json")),
    );
  });

  it("debug_log deep-equals fixture", () => {
    expect(normalize(encodeStatement(debugLog(c.int(123))))).toEqual(
      normalize(loadFixture("statements/debug_log.json")),
    );
  });

  it("foreach_break deep-equals fixture (empty context)", () => {
    expect(normalize(encodeStatement(foreachBreak()))).toEqual(
      normalize(loadFixture("statements/foreach_break.json")),
    );
  });

  it("foreach_continue / foreach_remove encode with empty context", () => {
    const cont = encodeStatement(foreachContinue());
    expect(cont.name).toBe("mvp:foreach_continue");
    expect(cont.context).toEqual({});
    expect(cont.input).toEqual([]);
    const rem = encodeStatement(foreachRemove());
    expect(rem.name).toBe("mvp:foreach_remove");
    expect(rem.context).toEqual({});
    expect(rem.input).toEqual([]);
  });

  it("all control-flow specials are registered", () => {
    for (const n of [
      "mvp:return",
      "mvp:die",
      "mvp:debug_log",
      "mvp:foreach_break",
      "mvp:foreach_continue",
      "mvp:foreach_remove",
    ]) {
      expect(isRegisteredStatement(n)).toBe(true);
    }
  });
});
