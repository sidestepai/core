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
// it is discoverable but unusable.
// Raised again from 27.2k for URL path params: `{param}` segments are a whole
// addressing capability with a hard authoring rule behind them (an unbound
// marker throws), and the `getPath({ params })` / handle-`toSearchParams` recipe
// is the client half an agent cannot infer from the def.
// Raised again from 27.4k for the three realtime answers in #164: how a stack
// READS a channel path param (`inp("room_id")`) and what `get_session` holds, and
// the presence frame payload shapes (`presence_full.members` vs
// `presence_join.member`, and the member entry). All three were named-but-unshaped
// surfaces an author had to guess at and defend against — the exact thing this doc
// exists to prevent.)
// Raised again from 28.1k for three surfaces a pulled workspace proved are real
// and nothing modelled: `input.file` (a raw upload, and the ONLY type with no
// `f.` column form — an agent that assumes the catalogs mirror will write
// `f.file` and get nothing), plus `db.get_by_id` and `security.create_guid`,
// which are distinct stored statements from their near-neighbours `db.get` and
// `security.create_uuid` and cannot be inferred from them.
// Raised again from 28.15k for `input.dbLink`. It earns prose rather than a
// catalog row because it is the one input whose ENTRY IS NOT THE INPUT: the
// engine expands one dblink into one input per column of the linked table, so an
// agent that reads it by the entry's own name gets nothing and has no way to
// discover why. The 718 of them in the sweep are all `merge: true`.
// Raised again from 28.25k for the RETIRED statement versions in the Legacy
// index. Four crypto families are versioned by suffix and only the highest
// number is offered; the earlier ones still run, so a pulled workspace holds
// them, but each version was a BREAKING change to the one before. They have no
// `s.` surface at all now, which means the only thing standing between an agent
// and "fixing" a `raw({name:"mvp:crypto_jwe_encode"})` it does not recognize is
// this list. Note the catalog also SHRANK here (two authorable surfaces removed),
// so the net rise is smaller than the section itself.
// Raised again from 28.4k for `mixed(...)`. It is the rare case where the doc
// exists to talk an agent OUT of a surface: the container is authorable only so a
// pulled workspace round-trips, and the paragraph has to carry the reason —
// `a OR b AND c` means `(a OR b) AND c` in a branch and `a OR (b AND c)` in a
// query filter, because one folds left to right and the other inherits the
// database's precedence. Naming it without that is worse than not naming it, and
// the alternative (`and(or(a,b),c)`) only reads as advice once you know why.
const CEILING_TOKENS = 28_550;

describe("llms.txt token budget", () => {
  it("stays under the bloat-tripwire ceiling", () => {
    const { totalTokens } = measureCommittedLlms();
    expect(totalTokens).toBeLessThanOrEqual(CEILING_TOKENS);
  });
});
