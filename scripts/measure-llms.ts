/**
 * Token-footprint measurement for `llms.txt` (`npm run measure:llms`). Encodes the
 * committed grounding doc with the o200k_base tokenizer — a proxy for the modern
 * models that actually consume it — and prints a total plus a per-`## `-section
 * breakdown, so the slimming work has a hard before/after number and section
 * weights are visible at a glance. Dev-only tooling; never shipped.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface SectionTokens {
  title: string;
  tokens: number;
}

export interface LlmsMeasurement {
  totalTokens: number;
  chars: number;
  sections: SectionTokens[];
}

/**
 * Measure total + per-H2-section token counts for an `llms.txt` string. Sections
 * are split on `## ` headings; any content above the first heading is reported as
 * `(header)`. Section token counts are measured independently, so they sum to
 * slightly less than the whole-file total (the tokenizer sees section boundaries
 * differently in isolation) — treat them as relative weights, not an exact
 * partition.
 */
export function measureLlms(text: string): LlmsMeasurement {
  const sections: { title: string; body: string[] }[] = [];
  const preamble: string[] = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of text.split("\n")) {
    if (/^## /.test(line)) {
      current = { title: line.replace(/^##\s+/, ""), body: [line] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }

  const secTokens: SectionTokens[] = sections.map((s) => ({
    title: s.title,
    tokens: encode(s.body.join("\n")).length,
  }));
  if (preamble.join("").trim().length > 0) {
    secTokens.unshift({ title: "(header)", tokens: encode(preamble.join("\n")).length });
  }

  return { totalTokens: encode(text).length, chars: text.length, sections: secTokens };
}

/** Read the committed `llms.txt` from the repo root and measure it. */
export function measureCommittedLlms(): LlmsMeasurement {
  return measureLlms(readFileSync(join(ROOT, "llms.txt"), "utf8"));
}

// CLI: print the breakdown when invoked via `npm run measure:llms`.
if (process.argv[1]?.includes("measure-llms")) {
  const m = measureCommittedLlms();
  const pad = Math.max(...m.sections.map((s) => s.title.length), 10);
  console.log(`llms.txt — ${m.totalTokens} tokens (o200k_base), ${m.chars} chars\n`);
  for (const s of m.sections) {
    const pct = Math.round((s.tokens / m.totalTokens) * 100);
    console.log(`  ${s.title.padEnd(pad)}  ${String(s.tokens).padStart(6)}  ${String(pct).padStart(3)}%`);
  }
}
