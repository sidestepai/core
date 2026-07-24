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
// Set generously above the post-slim footprint (~22.5k), below the pre-slim
// baseline (~26.8k). Headroom for legitimate critical additions; raise it if a real
// Gotcha/Special pushes past, never cut grounding to fit.
const CEILING_TOKENS = 24_000;

describe("llms.txt token budget", () => {
  it("stays under the bloat-tripwire ceiling", () => {
    const { totalTokens } = measureCommittedLlms();
    expect(totalTokens).toBeLessThanOrEqual(CEILING_TOKENS);
  });
});
