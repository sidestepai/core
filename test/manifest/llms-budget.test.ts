import { describe, it, expect } from "vitest";
import { measureCommittedLlms } from "../../scripts/measure-llms.js";

/**
 * Bloat tripwire for the committed `llms.txt` — deliberately NOT a hard budget gate.
 *
 * The ceiling is set generously (with headroom above the current footprint) so it
 * catches accidental runaway growth without ever pressuring an author to cut
 * authoring-critical content. If a legitimate new Gotcha or Special signature
 * pushes the doc past the ceiling, RAISE the ceiling — do not delete critical
 * grounding to fit under it (that would invert the whole point of the doc).
 *
 * Inspect the current footprint any time with `npm run measure:llms`.
 */
const CEILING_TOKENS = 28_000; // Tightened toward ~24k in U7 once the slimming lands.

describe("llms.txt token budget", () => {
  it("stays under the bloat-tripwire ceiling", () => {
    const { totalTokens } = measureCommittedLlms();
    expect(totalTokens).toBeLessThanOrEqual(CEILING_TOKENS);
  });
});
