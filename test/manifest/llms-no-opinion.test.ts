import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No-opinion guard for the committed `llms.txt`.
 *
 * SideStep is the source of truth for its own authoring surface, so the grounding
 * doc explains what a feature is and how to use it — never why it diverges from the
 * Xano UI, nor the design history behind a choice. That justification prose is pure
 * token cost and signal dilution for the agents that consume this file.
 *
 * This scans for self-justification signatures (design history, alternative-API /
 * UI comparison framing, internal SideStep-implementation asides). It is patterned
 * on narration, NOT on authoring-critical negations — a load-bearing "NOT `ref`" or
 * "does NOT throw" is fine; "the old #118 rejection no longer reproduces" is not.
 * If a match is a genuine false positive, narrow the pattern rather than deleting
 * the guard.
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
];

describe("llms.txt has no self-justification prose", () => {
  const text = readFileSync(join(ROOT, "llms.txt"), "utf8");
  const lines = text.split("\n");

  for (const { pattern, why } of BANNED) {
    it(`is free of ${why} (${pattern})`, () => {
      const hits = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => pattern.test(line))
        .map(({ line, n }) => `llms.txt:${n}: ${line.trim()}`);
      expect(hits, hits.join("\n")).toHaveLength(0);
    });
  }
});
