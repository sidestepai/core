import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No-opinion guard for the committed grounding artifacts (`llms.txt`,
 * `manifest.json`).
 *
 * SideStep is the source of truth for its own authoring surface, so the grounding
 * doc explains what a feature is and how to use it — never why it diverges from the
 * Xano UI, nor the design history behind a choice. That justification prose is pure
 * token cost and signal dilution for the agents that consume this file.
 *
 * This scans for four defect classes, all of which cost tokens without changing what
 * code a correct agent writes:
 *
 *  1. **Self-justification** — design history, UI-comparison framing, internal
 *     SideStep-implementation asides.
 *  2. **Issue references** — a bare `#NN` resolves to nothing for any consumer
 *     outside this repo. The constraint it annotates is the signal; the tag is cost.
 *     (An earlier pass kept these as "verified gotcha" markers. That signal is
 *     invisible to every reader of the shipped file.)
 *  3. **Dev-process language** — how a fact was verified here (goldens,
 *     byte-verification) is our workflow, not the reader's.
 *  4. **Engine internals** — naming how the engine is BUILT. Distinct from wire
 *     shape: `mvp:*` statement names and `context.*` bundle keys appear in the
 *     bundle an agent reads and writes, so they are legitimate and the patterns
 *     below are written not to catch them.
 *
 * Patterned on narration, NOT on authoring-critical negations — a load-bearing
 * "NOT `ref`" or "does NOT throw" is fine; "the old #118 rejection no longer
 * reproduces" is not. The KEEPS block below pins that distinction as an assertion,
 * so widening a pattern until it eats real grounding fails loudly. If a match is a
 * genuine false positive, narrow the pattern rather than deleting the guard.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /\bnever worked\b/i, why: "design history" },
  { pattern: /\bno longer reproduces?\b/i, why: "resolved-bug history" },
  { pattern: /\bused to be\b/i, why: "design history" },
  { pattern: /\bthird-party engine behavior\b/i, why: "distancing aside" },
  { pattern: /\bdiverges from this API\b/i, why: "comparison framing" },
  { pattern: /which the import ignores/i, why: "internal-impl reasoning" },
  { pattern: /does not compute the fallback/i, why: "internal-impl reasoning" },
  { pattern: /the raw tag ["'`]?env/i, why: "internal-impl reasoning" },
  { pattern: /\bnot (exactly )?1:1\b/i, why: "UI-comparison framing" },
  { pattern: /\bunlike the [^.]*\b(ui|dashboard)\b/i, why: "UI-comparison framing" },
  // Issue references. Only markdown headings use `#` in llms.txt, so `#<digit>`
  // is unambiguous.
  { pattern: /#\d+/, why: "issue reference" },
  // Dev-process language.
  { pattern: /\bbyte-verif/i, why: "dev-process language" },
  { pattern: /\bgolden\b/i, why: "dev-process language" },
  { pattern: /\bconformance corpus\b/i, why: "dev-process language" },
  // Engine internals. `mvp:dbo_view` is a STATEMENT NAME (wire-visible, an agent
  // reads it in a pulled bundle) — the lookbehind keeps it legal while catching
  // prose that describes the engine's own construction.
  { pattern: /(?<!mvp:)\bdbo_view\b/, why: "engine internal" },
  { pattern: /\bsearch reader\b/i, why: "engine internal" },
  // Self-referential size claims drift the moment either artifact changes.
  { pattern: /~\s*\d+(\.\d+)?x this file/i, why: "drifting self-reference" },
];

/**
 * Text that MUST survive every pattern above. These are the load-bearing negations
 * and wire-visible identifiers the guard is most likely to eat if a pattern is
 * widened carelessly — the failure mode the header warns about, asserted rather
 * than trusted.
 */
const ARTIFACTS = ["llms.txt", "manifest.json"] as const;

const KEEPS: { text: string; in: (typeof ARTIFACTS)[number] }[] = [
  // Load-bearing negations.
  { text: "Foreign key is `f.tableRef(table)`, not `ref`.", in: "llms.txt" },
  { text: "`db.get` binds `null` on a no-match, but a nested `ref(\"owner.user_id\")`", in: "llms.txt" },
  { text: "0 MEANS OFF", in: "llms.txt" },
  { text: "does NOT run its stack", in: "llms.txt" },
  { text: "a bare path is NOT accepted", in: "llms.txt" },
  // Wire-visible identifiers. `mvp:dbo_view` proves the `dbo_view` lookbehind
  // spares a statement NAME; it lives only in manifest.json, since llms.txt
  // carries authoring signatures rather than the engine-ID column.
  { text: "mvp:dbo_view", in: "manifest.json" },
  { text: "mvp:crypto_jwe_encode3", in: "llms.txt" },
  { text: "context.search", in: "llms.txt" },
  { text: "`X-Xano-Canonical`", in: "llms.txt" },
];

describe("grounding artifacts carry no self-justification prose", () => {
  for (const artifact of ARTIFACTS) {
    const lines = readFileSync(join(ROOT, artifact), "utf8").split("\n");

    for (const { pattern, why } of BANNED) {
      it(`${artifact} is free of ${why} (${pattern})`, () => {
        const hits = lines
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => pattern.test(line))
          .map(({ line, n }) => `${artifact}:${n}: ${line.trim().slice(0, 200)}`);
        expect(hits, hits.join("\n")).toHaveLength(0);
      });
    }
  }
});

describe("the guard does not eat load-bearing grounding", () => {
  const sources = new Map(ARTIFACTS.map((a) => [a, readFileSync(join(ROOT, a), "utf8")]));

  for (const { text, in: artifact } of KEEPS) {
    it(`keeps: ${text.slice(0, 60)}`, () => {
      expect(sources.get(artifact)!, `"${text}" is gone from ${artifact}`).toContain(text);
      // …and no BANNED pattern would have removed it.
      const eaten = BANNED.filter(({ pattern }) => pattern.test(text));
      expect(
        eaten.map((e) => `${e.why} ${e.pattern}`),
        `a BANNED pattern matches load-bearing text: ${text}`,
      ).toHaveLength(0);
    });
  }
});
