/**
 * Harvester for the engine's per-statement RUNTIME INPUT schema — the second
 * codegen source, and the only one that knows a field's legal values.
 *
 * The transform schema (see {@link ./parse.ts}) says WHERE an authored field
 * lands in the stored bytes, and types everything it routes to `input[]` as a
 * generic tagged value. The runtime input schema says WHAT that field may hold,
 * and for a closed set spells it `enum|values([…])`. Nothing else in the
 * pipeline carries that fact, so without this harvest the SDK's factories, its
 * grounding docs, and its authoring guard are all silent about the legal
 * spellings — an author (or an agent) writes a plausible-but-wrong value and
 * only finds out after deploy.
 *
 * Deliberately narrow, matching the posture of the transform parser: it reads
 * the one declaration shape it understands and SKIPS everything else rather
 * than guessing. Skips are silent because they are the common case (most fields
 * are not enums at all), but a skip never produces a partial or invented set —
 * a field either yields its exact declared values or yields nothing.
 *
 * Pure string-in/data-out; the directory walk lives in `scripts/codegen.ts`
 * alongside the other source-reading code.
 */

/** One statement's harvested enum constraints: stored input name → legal values. */
export type StatementEnums = Record<string, string[]>;

/** The harvest for one statement: its stored name plus every enum-constrained field. */
export interface InputSchemaEnums {
  /** Stored statement name, e.g. `mvp:mcp_call_tool`. */
  name: string;
  /** Stored input name → legal values, in the engine's declared order. */
  enums: StatementEnums;
}

/**
 * The `tag` field is excluded everywhere. It enumerates the SDK's OWN value
 * tags, which `src/values/value.ts` already models as a closed `Tag` union on
 * every {@link ../../values/value.js Value} — re-encoding it as a per-field
 * string enum would both duplicate that and collide with the `Value` shape the
 * field actually takes.
 */
const EXCLUDED_FIELDS = new Set(["tag"]);

/** The stored name a statement declares for itself. */
const STORED_NAME = /function getName\(\)[^{]*\{\s*return\s*"([^"]+)"\s*;/;

/** The start of the runtime input schema declaration. */
const INPUT_SCHEMA_MARKER = "function getInputSchema";
/** The start of the next declaration — the input schema never runs past it. */
const OUTPUT_SCHEMA_MARKER = "function getOutputSchema";

/** The constraint spelling, as it appears at the end of a field's type. */
const ENUM_MARKER = ": enum|values(";

/**
 * Extract the schema block a declaration passes as a single-quoted literal.
 *
 * Single-quoted ONLY, by design. Every enum-bearing input schema is declared
 * that way, and the alternative delimiter cannot be sliced unambiguously here:
 * the values lists are themselves double-quoted, so finding the block's real
 * end would take a full string-literal parser for a form that does not occur.
 * Anything else — another delimiter, a dynamically built block — returns null
 * and is skipped rather than guessed at.
 */
function schemaLiteral(src: string): string | null {
  const open = src.match(/decode\(\s*'/);
  if (!open || open.index === undefined) return null;
  const start = open.index + open[0].length;
  const end = src.indexOf("'", start);
  return end === -1 ? null : src.slice(start, end);
}

/**
 * The lines at the block's OUTERMOST indentation — the statement's own top-level
 * fields. Nested blocks (a value's `{value,tag,filters}` members, a sort spec's
 * `{field,order}`) are intentionally out of reach: their names are not stored
 * `input[]` names, so they have nothing to join against and would only produce
 * false matches.
 */
function topLevelLines(block: string): string[] {
  const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const outermost = Math.min(...lines.map((l) => l.length - l.trimStart().length));
  return lines.filter((l) => l.length - l.trimStart().length === outermost).map((l) => l.trim());
}

/**
 * Read one field declaration's enum constraint, or null when the line does not
 * declare one (the common case) or declares one this cannot resolve statically.
 *
 * The values list is parsed as JSON rather than split on commas: the declared
 * lists carry inconsistent interior whitespace (`["resend", "xano"]`), and a
 * naive split would leak it into the values.
 */
function fieldEnum(line: string): { field: string; values: string[] } | null {
  const at = line.lastIndexOf(ENUM_MARKER);
  if (at === -1) return null;

  // The key may carry a leading `?`, a list marker, a trailing `?`, and a
  // default (`?="API Key"`); the bare identifier is the stored input name.
  const field = line.slice(0, at).replace(/^\?/, "").match(/^[A-Za-z0-9_]+/)?.[0];
  if (!field || EXCLUDED_FIELDS.has(field)) return null;

  const rest = line.slice(at + ENUM_MARKER.length);
  if (!rest.endsWith(")")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rest.slice(0, -1));
  } catch {
    return null; // a format placeholder or an interpolation — not statically knowable
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((v) => typeof v === "string")) return null;

  return { field, values: parsed as string[] };
}

/**
 * Harvest one statement source's enum-constrained input fields.
 *
 * Returns null when the source declares no stored name, no runtime input
 * schema, or no statically-readable schema block — all ordinary, and none of
 * them a reason to fail the run.
 */
export function parseInputSchema(src: string): InputSchemaEnums | null {
  const name = src.match(STORED_NAME)?.[1];
  if (!name) return null;

  const start = src.indexOf(INPUT_SCHEMA_MARKER);
  if (start === -1) return null;
  const stop = src.indexOf(OUTPUT_SCHEMA_MARKER, start);
  const block = schemaLiteral(src.slice(start, stop === -1 ? undefined : stop));
  if (block === null) return null;

  const enums: StatementEnums = {};
  for (const line of topLevelLines(block)) {
    const found = fieldEnum(line);
    // First declaration wins, so a repeated field stays deterministic.
    if (found && !(found.field in enums)) enums[found.field] = found.values;
  }
  return Object.keys(enums).length === 0 ? null : { name, enums };
}
