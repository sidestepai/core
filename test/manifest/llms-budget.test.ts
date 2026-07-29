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
// Set generously above the current footprint (~24.9k), below the pre-slim
// baseline (~26.8k). Headroom for legitimate critical additions; raise it if a
// real Gotcha/Special/result binding pushes past, never cut grounding to fit.
// (Raised from 24.8k when the codegen/pull command family landed — a whole new
// CLI direction is exactly the "legitimate critical addition" this rule means.
// Raised again from 25.2k when the realtime family landed: three new object
// kinds plus two lifecycle trigger types are authoring-critical grounding.
// Ratchet it back down after any real reduction, per the inverse rule.
// Raised again from 25.8k for `c.expression`: a new authoring constructor whose
// entire point is a safety warning — an unvalidated passthrough an agent must be
// told not to reach for by default — plus the `## Legacy` index that keeps
// superseded paradigms recognizable without making them selectable. Cutting
// either to fit would delete exactly the grounding this doc exists to carry.
// Raised again from 26.0k when the realtime family became authorable end-to-end:
// its three def shapes were missing from "Object def shapes" entirely, and the
// client recipe — `getUrl`/`getChannel` plus the frame vocabulary — is the half
// of realtime an agent cannot infer from a def, so a realtime primitive without
// it is discoverable but unusable.)
const CEILING_TOKENS = 27_200;

describe("llms.txt token budget", () => {
  it("stays under the bloat-tripwire ceiling", () => {
    const { totalTokens } = measureCommittedLlms();
    expect(totalTokens).toBeLessThanOrEqual(CEILING_TOKENS);
  });
});
