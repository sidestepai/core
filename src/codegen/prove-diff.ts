/**
 * Why a decoder declined — maintainer instrumentation for `codegen:sweep`.
 *
 * Every non-`raw` decode arm is proof-carrying: it builds a candidate, calls the
 * real `s.<path>` factory, re-encodes, and compares against the stored statement.
 * A candidate that does not reproduce the bytes returns `null` and the statement
 * degrades to `raw()` — exact, but unreadable. The decline itself is silent,
 * which makes a sweep report *that* thousands of statements fell back without
 * ever saying *why*.
 *
 * With `SIDESTEP_PROVE_DIFF` set to a file path, each decline appends one JSON
 * line naming the stored statement, the arm that declined, and the key paths
 * where the re-encode disagreed. Clustering those key paths is what turns "85
 * statement types have no decoder" into a handful of shared canonicalization
 * gaps.
 *
 * **A decline is not a fallback.** Every candidate is recorded, including ones a
 * later arm goes on to prove — a name can decline through its spec inverse and
 * still decode fine through a special. Decline counts are therefore an upper
 * bound on `raw-fallback` counts, and reading them as the same number is the
 * first wrong conclusion this data invites. Cross-reference the sweep CSV for
 * what actually fell back.
 *
 * Unset (the default, and always in a user's install) this costs one property
 * read per decline and writes nothing.
 */
import { appendFileSync } from "node:fs";

/** Key paths recorded per decline. A pathological statement must not write unbounded output. */
const MAX_PATHS = 40;
/** How deep the differ walks before giving up on a divergence. */
const MAX_DEPTH = 12;
/** How much of a disagreeing value is quoted. Enough to recognize, not enough to flood. */
const MAX_PREVIEW = 60;

/** The sink path, or `undefined` when instrumentation is off. Read per call so tests can toggle it. */
function sink(): string | undefined {
  return process.env["SIDESTEP_PROVE_DIFF"];
}

/** A disagreeing value, JSON-quoted and clipped. */
function preview(v: unknown): string {
  const json = JSON.stringify(v) ?? "undefined";
  return json.length > MAX_PREVIEW ? `${json.slice(0, MAX_PREVIEW)}…` : json;
}

function walk(encoded: unknown, stored: unknown, path: string, out: string[], depth: number): void {
  if (out.length >= MAX_PATHS || depth > MAX_DEPTH) return;

  const bothObjects =
    encoded !== null &&
    stored !== null &&
    typeof encoded === "object" &&
    typeof stored === "object";
  if (!bothObjects) {
    if (JSON.stringify(encoded) !== JSON.stringify(stored)) {
      out.push(`${path}: encoded=${preview(encoded)} stored=${preview(stored)}`);
    }
    return;
  }

  const encodedIsArray = Array.isArray(encoded);
  if (encodedIsArray !== Array.isArray(stored)) {
    // The empty-array/empty-object split: one side decoded a JSON `[]` where the
    // other built `{}`. Naming the shape is the whole finding, so stop here.
    out.push(
      `${path}: shape encoded=${encodedIsArray ? "array" : "object"} stored=${Array.isArray(stored) ? "array" : "object"}`,
    );
    return;
  }

  if (encodedIsArray) {
    const a = encoded as unknown[];
    const b = stored as unknown[];
    if (a.length !== b.length) out.push(`${path}: length encoded=${a.length} stored=${b.length}`);
    // Collapse indices to `[]` so N sibling entries diverging the same way
    // cluster as one signature instead of N.
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      walk(a[i], b[i], `${path}[]`, out, depth + 1);
    }
    return;
  }

  const a = encoded as Record<string, unknown>;
  const b = stored as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (out.length >= MAX_PATHS) return;
    if (!(key in a)) out.push(`${path}.${key}: MISSING from encoded (stored=${preview(b[key])})`);
    else if (!(key in b)) out.push(`${path}.${key}: EXTRA in encoded (${preview(a[key])})`);
    else walk(a[key], b[key], `${path}.${key}`, out, depth + 1);
  }
}

/**
 * The key paths where a re-encode disagreed with the stored statement.
 *
 * Pass values that have already been through `normalize()` — the point is to see
 * what survives canonicalization, not to re-report what it already elides.
 */
export function diffKeyPaths(encoded: unknown, stored: unknown): string[] {
  const out: string[] = [];
  walk(encoded, stored, "", out, 0);
  return out;
}

/** Record a declined proof. No-op unless `SIDESTEP_PROVE_DIFF` names a file. */
export function recordProveDecline(
  arm: string,
  name: unknown,
  encoded: unknown,
  stored: unknown,
): void {
  const file = sink();
  if (file === undefined || file === "") return;
  appendFileSync(file, `${JSON.stringify({ arm, name, diffs: diffKeyPaths(encoded, stored) })}\n`);
}

/**
 * Record a candidate that could not even be built — the factory threw before any
 * comparison happened. Distinguishing this from a byte mismatch matters: a throw
 * means the recovered arguments were the wrong *shape*, not the wrong value.
 */
export function recordProveAbort(arm: string, name: unknown, why: string): void {
  const file = sink();
  if (file === undefined || file === "") return;
  appendFileSync(file, `${JSON.stringify({ arm, name, diffs: [`ABORT: ${why}`] })}\n`);
}
