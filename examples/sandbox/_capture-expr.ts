/**
 * Expression-parity capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * Sources real engine goldens for the unified-expression-parity plan
 * (2026-07-24-003). Probe #1 answers the single highest-value unknown: what wire
 * shape does the engine persist for a FILTERED operand in a comparison, and does
 * a conditional accept it? (The SDK emits a filtered conditional operand today
 * via the pass-through encoder — db search rejects it, #118 — so a conditional is
 * the only SDK-expressible filtered operand before the U3/U4 widening.)
 *
 * Run:  node dist/bin.js validate examples/sandbox/_capture-expr.ts --capture --runtime --out validate-out
 */
import { workspace, defineFunction, s, c, ref, expr, withFilters, filter } from "@sidestep/core";

const defs = (xs: unknown[]) => xs as never[];

/**
 * Probe #1 — a conditional whose LEFT operand carries a `count` filter
 * (`nums |count > 0`). Captures the persisted filtered-operand shape.
 */
const probeCondFiltered = defineFunction({
  name: "ex_probe_cond_filtered",
  stack: [
    s.set_var("nums", withFilters(c.text("[1,2,3]"), filter("json_decode"))),
    s.conditional({
      when: expr(withFilters(ref("nums"), filter("count")), ">", c.int(0)),
      then: [s.set_var("ok", c.text("yes"))],
      else: [s.set_var("ok", c.text("no"))],
    }),
  ],
  response: ref("ok"),
});

/**
 * Probe #2 — a conditional with an `elif` chain (two branches) + `else`.
 * Byte-verifies the new `mvp:conditional_elif` stack shape against the engine.
 */
const probeCondElif = defineFunction({
  name: "ex_probe_cond_elif",
  stack: [
    s.set_var("n", c.int(5)),
    s.conditional({
      when: expr(ref("n"), ">", c.int(10)),
      then: [s.set_var("bucket", c.text("high"))],
      elif: [
        { when: expr(ref("n"), ">", c.int(3)), then: [s.set_var("bucket", c.text("mid"))] },
        { when: expr(ref("n"), ">", c.int(0)), then: [s.set_var("bucket", c.text("low"))] },
      ],
      else: [s.set_var("bucket", c.text("none"))],
    }),
  ],
  response: ref("bucket"),
});

export default workspace("sidestep-capture-expr").registerFunctions(
  defs([probeCondFiltered, probeCondElif]),
);
