/**
 * Branching block specials (U10) — `switch` / `switch_case` / `try_catch`,
 * validated against the engine's golden fixtures.
 *
 * Unlike for/foreach (which have transform-temp "stored" fixtures), switch and
 * try_catch only have parser `script2json/minimal` goldens vendored here. That
 * minimal form is identical to the stored bundle form *except* it omits empty
 * envelope members — `input: []` and `context: {}` — which the SDK always emits
 * via the base statement encoder. `minimal()` drops those empties (recursively,
 * on both sides) on top of the shared `normalize`, so the comparison still
 * checks every authored field while ignoring that representational artifact.
 */
import { describe, it, expect } from "vitest";
import "../../src/index.js"; // side-effect: register all kinds + statements (incl. mvp:lambda)
import { switchStatement, tryCatch } from "../../src/statements/special/branch.js";
import { setVar } from "../../src/statements/set-var.js";
import { encodeStatement, getStatementFactory } from "../../src/statements/statement.js";
import { c, ref } from "../../src/values/value.js";
import { normalize, loadFixture } from "../conformance/harness.js";

/** Drop empty `input: []` / `context: {}` the parser-minimal golden omits. */
function minimal<T>(value: T): T {
  if (Array.isArray(value)) return value.map(minimal) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "input" && Array.isArray(v) && v.length === 0) continue;
      if (k === "context" && v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
        continue;
      out[k] = minimal(v);
    }
    return out as unknown as T;
  }
  return value;
}

const norm = (v: unknown) => minimal(normalize(v));

// The stored lambda body from switch.json (dedented heredoc).
const LAMBDA_CODE =
  "if ($input.left > $input.right) {\n" +
  '    return "left is greater than right";\n' +
  "} else if ($input.left < $input.right) {\n" +
  '    return "left is smaller than right";\n' +
  "} else {\n" +
  '    return "left and right are equal";\n' +
  "}";

describe("branching block specials — deep-equal vs golden parser fixtures", () => {
  it("switch deep-equals switch.json", () => {
    const built = encodeStatement(
      switchStatement({
        on: ref("x1"),
        cases: [
          {
            when: c.text("wow"),
            body: [
              setVar("x3", c.text("ok")),
              getStatementFactory("mvp:lambda")({
                as: "is_equal",
                code: c.text(LAMBDA_CODE),
                timeout: c.int(10),
              }),
            ],
          },
        ],
        default: [setVar("x2", c.text("dude"))],
      }),
    );
    expect(norm(built)).toEqual(norm(loadFixture("statements/switch.json")));
  });

  it("try_catch deep-equals try_catch.json (try→if, catch→else, finally→then)", () => {
    const built = encodeStatement(
      tryCatch({
        try: [setVar("x1", c.int(1))],
        catch: [setVar("x1", c.int(2))],
        finally: [setVar("x1", c.int(31))],
      }),
    );
    expect(norm(built)).toEqual(norm(loadFixture("statements/try_catch.json")));
  });

  it("switch_case omits break unless set, and emits it when set", () => {
    const caseContext = (stmt: ReturnType<typeof encodeStatement>): Record<string, unknown> =>
      (stmt.context as { elif: { run: Array<{ context: Record<string, unknown> }> } }).elif.run[0]!
        .context;

    const noBreak = encodeStatement(
      switchStatement({ on: ref("x"), cases: [{ when: c.int(1), body: [] }] }),
    );
    expect("break" in caseContext(noBreak)).toBe(false);

    const withBreak = encodeStatement(
      switchStatement({ on: ref("x"), cases: [{ when: c.int(1), body: [], break: true }] }),
    );
    expect(caseContext(withBreak).break).toBe(true);
  });

  it("all branching specials are registered", () => {
    for (const n of ["mvp:switch", "mvp:switch_case", "mvp:try_catch"]) {
      expect(getStatementFactory(n)).toBeTypeOf("function");
    }
  });
});
