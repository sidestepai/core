/**
 * Runtime round-trip verification (KTD-9) — on by default, not a test-only claim.
 *
 * Every decoder is proof-carrying, so a *statement* cannot decode wrongly without
 * falling back to `raw()`. What that does not cover is everything outside a
 * statement: a def key elided because the encoder appeared to reproduce it, a
 * kind-level default read one way, a field descriptor that re-encodes close
 * enough to pass its own check. Those show up only when the whole generated tree
 * is loaded and exported again.
 *
 * The corpus cannot reach a user's real workspace, so this runs there instead:
 * load the tree that was just written, export it, and diff against the bundle it
 * came from under `normalize()`. A clean run is then a property the user
 * actually has, rather than something the test suite asserted about other data.
 *
 * Node-only (it imports the generated tree); reached through the CLI, never from
 * the browser-safe authoring entry.
 */
import { normalize } from "../validate/normalize.js";
import type { DecodeReport } from "./report.js";
import { sectionOmission, workspaceKeyOmission, type OmissionReason } from "./omissions.js";

/** One object whose re-export does not match the bundle it was decoded from. */
export interface VerifyMismatch {
  /** The payload section it lives in, e.g. `function`. */
  readonly payloadKey: string;
  readonly name: string;
  /** What differs, in one line. */
  readonly detail: string;
}

/**
 * One thing the generated tree left behind **on purpose** (see `omissions.ts`).
 *
 * Kept separate from {@link VerifyMismatch} because it means something opposite:
 * a mismatch says the round trip is broken, an omission says the round trip
 * worked and the SDK declined to carry a secret or a server-assigned value.
 * Folding the two together is what made a real-workspace pull look like it had
 * failed when it had not.
 */
export interface VerifyOmission {
  readonly payloadKey: string;
  /** The workspace key, or `(section)` for a whole payload section. */
  readonly name: string;
  readonly reason: OmissionReason;
  readonly detail: string;
}

/** The outcome of a runtime verification pass. */
export interface VerifyResult {
  /** True when nothing was *lost*. Deliberate omissions do not fail a run. */
  readonly ok: boolean;
  readonly mismatches: readonly VerifyMismatch[];
  readonly omissions: readonly VerifyOmission[];
}

/** Objects in a payload section, keyed by name. */
function sectionByName(payload: Record<string, unknown>, key: string): Map<string, unknown> {
  const section = payload[key];
  if (!Array.isArray(section)) return new Map();
  return new Map(section.map((o) => [String((o as { name?: unknown }).name ?? ""), o]));
}

/** Deep structural equality over normalized payload objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
  return true;
}

/** A plain object (not an array, not null) — the shape worth comparing per key. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Blank in the sense an `emptied` policy means: nothing was written here. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * Compare a non-array section (`workspace`, `partial`) key by key.
 *
 * "`workspace:(section)` does not match the source bundle" was true but useless
 * — a workspace object carries ~35 keys and the message named none of them. Per
 * key, the same run instead says which four differ and which of those were left
 * behind on purpose.
 */
function verifySection(
  key: string,
  before: unknown,
  after: unknown,
  mismatches: VerifyMismatch[],
  omissions: VerifyOmission[],
): void {
  if (deepEqual(normalize(before), normalize(after))) return;

  // A scalar (`partial`) has no keys to report against — compare it whole.
  if (!isPlainObject(before) || !isPlainObject(after)) {
    mismatches.push({ payloadKey: key, name: "(section)", detail: "section does not match the source bundle" });
    return;
  }

  const omissionFor = key === "workspace" ? workspaceKeyOmission : () => undefined;
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const left = before[name];
    const right = after[name];
    if (deepEqual(normalize(left), normalize(right))) continue;

    // Only an *absence* can be a deliberate omission — or, for the one key
    // marked `emptied`, a value the generated tree deliberately blanks. A key
    // emitted with some *other* value is a real divergence no policy excuses.
    const candidate = omissionFor(name);
    const policy =
      candidate && (right === undefined || (candidate.emptied === true && isEmpty(right)))
        ? candidate
        : undefined;
    if (policy) {
      omissions.push({ payloadKey: key, name, reason: policy.reason, detail: policy.detail });
      continue;
    }
    mismatches.push({
      payloadKey: key,
      name,
      detail:
        right === undefined
          ? "present in the source bundle but not in the generated tree"
          : left === undefined
            ? "present in the generated tree but not in the source bundle"
            : "re-exports differently than the source bundle",
    });
  }
}

/**
 * Compare a regenerated bundle against its source, per object.
 *
 * Reported per object rather than as one payload-wide diff: a whole-bundle
 * inequality tells a user nothing they can act on, whereas "`function
 * signup` differs" points at the file to look at.
 *
 * Objects in a section this SDK deliberately does not model are reported as
 * omissions rather than mismatches, so a real workspace carrying (say)
 * `knowledge` verifies clean while still saying out loud what was left behind.
 */
export function verifyBundles(source: unknown, regenerated: unknown): VerifyResult {
  const sourcePayload = ((source as { payload?: unknown })?.payload ?? {}) as Record<string, unknown>;
  const regeneratedPayload = ((regenerated as { payload?: unknown })?.payload ?? {}) as Record<
    string,
    unknown
  >;
  const mismatches: VerifyMismatch[] = [];
  const omissions: VerifyOmission[] = [];

  const keys = new Set([...Object.keys(sourcePayload), ...Object.keys(regeneratedPayload)]);
  for (const key of [...keys].sort()) {
    const before = sourcePayload[key];
    const after = regeneratedPayload[key];
    if (!Array.isArray(before) && !Array.isArray(after)) {
      verifySection(key, before, after, mismatches, omissions);
      continue;
    }
    const policy = sectionOmission(key);
    const beforeByName = sectionByName(sourcePayload, key);
    const afterByName = sectionByName(regeneratedPayload, key);
    for (const [name, original] of beforeByName) {
      if (!afterByName.has(name)) {
        if (policy) {
          omissions.push({ payloadKey: key, name, reason: policy.reason, detail: policy.detail });
          continue;
        }
        mismatches.push({ payloadKey: key, name, detail: "missing from the generated tree" });
        continue;
      }
      if (!deepEqual(normalize(original), normalize(afterByName.get(name)))) {
        mismatches.push({ payloadKey: key, name, detail: "re-exports differently than the source bundle" });
      }
    }
    for (const name of afterByName.keys()) {
      if (!beforeByName.has(name)) {
        mismatches.push({ payloadKey: key, name, detail: "present in the generated tree but not in the source bundle" });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches, omissions };
}

/** Fold a verification result into the decode report so every sink shows it. */
export function reportMismatches(report: DecodeReport, result: VerifyResult): void {
  for (const mismatch of result.mismatches) {
    report.add({
      category: "verify-mismatch",
      object: `${mismatch.payloadKey}:${mismatch.name}`,
      detail: mismatch.detail,
    });
  }
  for (const omission of result.omissions) {
    report.add({
      category: "expected-omission",
      object: `${omission.payloadKey}:${omission.name}`,
      detail: `${omission.detail} (${omission.reason})`,
    });
  }
}
