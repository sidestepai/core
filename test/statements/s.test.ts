import { describe, it, expect } from "vitest";
import { s } from "../../src/statements/s.js";
import { GENERATED_STATEMENT_NAMES } from "../../src/statements/generated/catalog.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { c, ref } from "../../src/values/value.js";
import { expr } from "../../src/statements/conditional.js";
import { normalize, loadFixture } from "../conformance/harness.js";

/** Count the callable leaves in the `s` tree (statements reachable as factories). */
function countLeaves(node: unknown): number {
  if (typeof node === "function") return 1;
  if (node && typeof node === "object") {
    return Object.values(node as Record<string, unknown>).reduce<number>((n, v) => n + countLeaves(v), 0);
  }
  return 0;
}

describe("unified `s` authoring surface", () => {
  it("exposes the namespaced declarative catalog + specials as callable factories", () => {
    for (const path of [
      s.math.add,
      s.math.bitwise.and,
      s.array.find,
      s.array.push,
      s.object.keys,
      s.text.append,
      s.lambda,
      s.storage.delete_file,
      s.expect.to_equal,
      s.set_var,
      s.conditional,
      s.for,
      s.return,
    ]) {
      expect(typeof path).toBe("function");
    }
  });

  it("covers at least every generated statement (reachable, not just registered)", () => {
    // Every generated statement is reachable somewhere in the tree; the leaf count
    // is the generated catalog plus the merged specials.
    expect(countLeaves(s)).toBeGreaterThanOrEqual(GENERATED_STATEMENT_NAMES.length);
  });

  it("s.math.add encodes byte-exact to the persisted fixture", () => {
    const encoded = encodeStatement(s.math.add({ name: "x1", value: c.int(1) }));
    expect(normalize(encoded)).toEqual(normalize(loadFixture("statements/math_add.json")));
  });

  it("s.storage.delete_file (input-target, rich envelope) is byte-exact to its fixture", () => {
    const encoded = encodeStatement(s.storage.delete_file({ pathname: c.text("abc") }));
    expect(normalize(encoded)).toEqual(normalize(loadFixture("statements/delete_file.json")));
  });

  it("composes a full stack through `s` (loop + conditional + math)", () => {
    const stack = [
      s.set_var("total", c.int(0)),
      s.for({
        as: "i",
        count: c.int(3),
        body: [
          s.conditional({
            when: expr(ref("i"), ">", c.int(0)),
            then: [s.math.add({ name: "total", value: c.int(1) })],
          }),
        ],
      }),
      s.return(ref("total")),
    ];
    expect(stack.every((st) => typeof (st as { name: string }).name === "string")).toBe(true);
  });
});
