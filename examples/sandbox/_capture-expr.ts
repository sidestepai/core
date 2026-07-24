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
import { workspace, defineFunction, s, c, ref, expr, cmp, and, or, withFilters, filter } from "@sidestep/core";

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

/**
 * Probe #3 — a conditional whose `when` is a nested AND/OR group over the full
 * operator set (`cmp` + `and`/`or`). Byte-verifies Gap A (grouping + full ops) on
 * the conditional surface.
 */
const probeCondGroup = defineFunction({
  name: "ex_probe_cond_group",
  stack: [
    s.set_var("status", c.text("active")),
    s.set_var("n", c.int(5)),
    s.conditional({
      when: and(
        cmp(ref("status"), "like", c.text("%active%")),
        or(expr(ref("n"), ">", c.int(0)), expr(ref("n"), "<", c.int(-10))),
      ),
      then: [s.set_var("hit", c.text("yes"))],
      else: [s.set_var("hit", c.text("no"))],
    }),
  ],
  response: ref("hit"),
});

/**
 * Probe #4 — a `while` with a grouped condition (never enters the body: the
 * group is false immediately). Byte-verifies Gap A on the while surface.
 */
const probeWhileGroup = defineFunction({
  name: "ex_probe_while_group",
  stack: [
    s.set_var("i", c.int(0)),
    s.while({
      when: and(expr(ref("i"), "<", c.int(0)), expr(ref("i"), ">", c.int(100))),
      body: [s.set_var("i", withFilters(ref("i"), filter("add", c.int(1))))],
    }),
  ],
  response: ref("i"),
});

export default workspace("sidestep-capture-expr").registerFunctions(
  defs([probeCondFiltered, probeCondElif, probeCondGroup, probeWhileGroup]),
);
