/**
 * Sub-stack block specials — `db.transaction` and `util.post_process`,
 * promoted from modeled → byte-verified against the engine's golden fixtures.
 *
 * Like switch/try_catch, these only have parser `script2json` goldens vendored
 * (no transform-temp "stored" fixture exists). The parser-minimal form equals
 * the stored bundle form *except* it omits degenerate envelope members the SDK
 * always emits — `input: []`, `context: {}`, an empty `as: ""`, and a bare
 * `output: { filters: [] }`. `minimal()` drops exactly those (recursively, on
 * both sides) on top of the shared `normalize`, so the comparison still checks
 * every authored field (and the run-stack children byte-for-byte) while ignoring
 * that representational artifact. Both statements are pure block statements
 * (engine schema `args: []`) — they carry no `as`.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // register all kinds + statements
import { dbTransaction } from "../../src/statements/special/db.js";
import { postProcess } from "../../src/statements/special/misc.js";
import { setVar } from "../../src/statements/set-var.js";
import { s } from "../../src/statements/s.js";
import { encodeStatement } from "../../src/statements/statement.js";
import { c } from "../../src/values/value.js";
import { normalize, loadFixture } from "../conformance/harness.js";

/** Drop the degenerate envelope members the parser-minimal golden omits. */
function minimal<T>(value: T): T {
  if (Array.isArray(value)) return value.map(minimal) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "input" && Array.isArray(v) && v.length === 0) continue;
      if (k === "as" && v === "") continue;
      if (k === "context" && isPlainObject(v) && Object.keys(v).length === 0) continue;
      if (k === "output" && isPlainObject(v) && Object.keys(v).length === 1 && Array.isArray(v.filters) && v.filters.length === 0)
        continue;
      out[k] = minimal(v);
    }
    return out as unknown as T;
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const norm = (v: unknown) => minimal(normalize(v));

/** The shared run-stack body both goldens use: set_var x1 = 123; math.add x1 + 321. */
const body = () => [setVar("x1", c.int(123)), s.math.add({ name: "x1", value: c.int(321) })];

describe("sub-stack block specials — deep-equal vs golden parser fixtures", () => {
  it("db.transaction deep-equals db_transaction.json (no as; just the run stack)", () => {
    const built = encodeStatement(dbTransaction({ body: body() }));
    expect(norm(built)).toEqual(norm(loadFixture("statements/db_transaction.json")));
  });

  it("util.post_process deep-equals post_process.json", () => {
    const built = encodeStatement(postProcess(body()));
    expect(norm(built)).toEqual(norm(loadFixture("statements/post_process.json")));
  });

  it("db.transaction has an empty top-level `as` (engine schema args: [])", () => {
    const built = encodeStatement(dbTransaction({ body: [] }));
    expect(built.as).toBe("");
  });
});
