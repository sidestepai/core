import { describe, it, expect } from "vitest";
import { buildManifest, FILTER_NOTES, SELF_EVIDENT_FILTERS } from "../../src/manifest/manifest.js";

/**
 * Guards the signature-first filter catalog: the lean `llms.txt` drops raw filter
 * descriptions and keeps a curated note only where the signature underspecifies.
 * The risk is that the curated set silently undershoots the filters that genuinely
 * need a note, dropping one to a bare signature. So this test recomputes the
 * "load-bearing" set from the source descriptions (non-name-restating AND a
 * complete sentence) and proves every member is a conscious decision — either a
 * FILTER_NOTES entry or an explicit SELF_EVIDENT_FILTERS acknowledgement.
 */
const m = buildManifest({ version: "test" });
const typed = m.filters.filter((f) => f.typed);
const typedNames = new Set(typed.map((f) => f.name));

/** Description merely restates the filter name (every name word appears in it). */
function restatesName(name: string, desc: string): boolean {
  const words = name
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 2)
    .map((t) => t.toLowerCase());
  const d = desc.toLowerCase();
  return words.length > 0 && words.every((w) => d.includes(w));
}

/** Description is a truncated fragment (no terminal punctuation). */
function truncated(desc: string): boolean {
  return !/[.!)\]}]$/.test(desc.trim());
}

const loadBearing = typed.filter(
  (f) => f.description !== undefined && !restatesName(f.name, f.description) && !truncated(f.description),
);

describe("llms.txt filter notes", () => {
  it("covers every load-bearing filter with a note or a self-evident acknowledgement", () => {
    const uncovered = loadBearing
      .map((f) => f.name)
      .filter((name) => FILTER_NOTES[name] === undefined && !SELF_EVIDENT_FILTERS.has(name));
    // If this fails, a filter whose name underspecifies its behavior would ship as a
    // bare signature. Add a FILTER_NOTES entry, or (only if the name is genuinely
    // clear) add it to SELF_EVIDENT_FILTERS.
    expect(uncovered).toEqual([]);
  });

  it("has no stale or misspelled curated entries", () => {
    const unknownNotes = Object.keys(FILTER_NOTES).filter((name) => !typedNames.has(name));
    const unknownSelfEvident = [...SELF_EVIDENT_FILTERS].filter((name) => !typedNames.has(name));
    expect(unknownNotes).toEqual([]);
    expect(unknownSelfEvident).toEqual([]);
  });
});
