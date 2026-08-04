import { describe, it, expect } from "vitest";
import { measureCommittedLlms, measureLlms } from "../../scripts/measure-llms.js";

/**
 * Bloat tripwire for the committed `llms.txt` — deliberately NOT a hard budget gate.
 *
 * It exists to catch a section accidentally duplicated or a generator looping: the
 * runaway cases, which are large. It does not exist to adjudicate every added
 * sentence. If a legitimate new Gotcha or Special signature pushes the doc past the
 * ceiling, RAISE the ceiling — never delete grounding to fit under it. That would
 * invert the whole point of the doc.
 *
 * Inspect the current footprint any time with `npm run measure:llms`.
 *
 * ## Keep the headroom PROPORTIONAL — the rule this file learned the hard way
 *
 * This ceiling was raised twenty-one times. The log of those raises used to live
 * here, and read as a whole it recorded a slow failure rather than twenty-one bouts
 * of bloat: the first ceiling sat ~1.9k tokens (≈8%) above the footprint, and every
 * later raise landed within tens of tokens of whatever the doc weighed that day. By
 * the twenty-first there were 18 tokens of headroom.
 *
 * At 18 tokens it had stopped being a tripwire and become a toll on ALL growth — a
 * one-line Gotcha tripped it, so the raise became a formality performed during
 * unrelated work, and a formality is not a control. That was the mechanism behind
 * all twenty-one raises.
 *
 * So: keep roughly **5% headroom** over the committed footprint. When a raise is
 * needed, raise to ~5% above the NEW footprint rather than to the footprint itself.
 * The inverse applies too, and is why this file is shorter than it was: ratchet back
 * down after a real reduction. The log is gone because its value was this rule, and
 * the rule is now asserted below rather than narrated.
 */
const CEILING_TOKENS = 31_000;

/** The proportional-headroom rule, as a test rather than a comment. */
const MIN_HEADROOM = 1.02;
const MAX_HEADROOM = 1.09;

describe("llms.txt token budget", () => {
  it("stays under the bloat-tripwire ceiling", () => {
    const { totalTokens } = measureCommittedLlms();
    expect(totalTokens).toBeLessThanOrEqual(CEILING_TOKENS);
  });

  /**
   * Guards the failure mode the header describes: a ceiling raised to sit exactly on
   * the footprint stops being a tripwire, and one left far above a real reduction
   * stops catching anything. Both directions fail here instead of going unnoticed
   * for twenty-one commits.
   */
  it("keeps the ceiling proportional to the footprint", () => {
    const { totalTokens } = measureCommittedLlms();
    const ratio = CEILING_TOKENS / totalTokens;
    expect(
      ratio,
      `ceiling ${CEILING_TOKENS} vs footprint ${totalTokens} (${ratio.toFixed(3)}x). ` +
        "Too tight and every added sentence needs a raise; too loose and it catches nothing. " +
        "Raise to ~5% above the new footprint, or ratchet down after a reduction.",
    ).toBeGreaterThan(MIN_HEADROOM);
    expect(ratio).toBeLessThan(MAX_HEADROOM);
  });
});

describe("llms.txt measurement", () => {
  it("reports per-section weights so a regression can be located, not just detected", () => {
    const m = measureCommittedLlms();
    expect(m.sections.length).toBeGreaterThan(5);
    expect(m.sections.every((s) => s.tokens > 0)).toBe(true);
    // Sections are measured independently, so they sum to slightly less than the
    // whole-file total — relative weights, not an exact partition.
    const sum = m.sections.reduce((n, s) => n + s.tokens, 0);
    expect(sum).toBeLessThanOrEqual(m.totalTokens);
    expect(sum).toBeGreaterThan(m.totalTokens * 0.9);
  });

  it("splits on `## ` headings and reports a preamble", () => {
    const m = measureLlms("intro line\n\n## First\nbody\n\n## Second\nmore\n");
    expect(m.sections.map((s) => s.title)).toEqual(["(header)", "First", "Second"]);
  });
});
