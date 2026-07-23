/**
 * The `sidestep validate` loop: import a compiled JSON bundle into a live
 * instance, then read each authored object back and diff it against what we
 * compiled (KTD-1/2). Acceptance of the real import is the R1 proof; the
 * per-object JSON diff is R2.
 *
 * Pure orchestration: it takes an already-serialized bundle and a client, so it
 * carries no file IO or module loading and is unit-testable with a fake client.
 * Round-trip parity is checked for every registered kind (see `./kinds.ts`):
 * tables (`dbo`), functions, queries, triggers, and the rest. A registered kind
 * the export does not surface as a populated top-level array (e.g. `tool`,
 * nested under `toolset`) is demoted to present-but-unchecked rather than
 * emitting a false per-object `missing` (R3).
 */
import { normalize } from "./normalize.js";
import { ROUND_TRIP_KINDS, indexByIdentity, resolveMatch, kindIsRunnable } from "./kinds.js";
import type { ImportResult } from "./meta-client.js";

/** The client surface the loop needs (satisfied structurally by MetaClient). */
export interface LoopClient {
  importBundle(bundle: string, opts?: { reset?: boolean }): Promise<ImportResult>;
  exportWorkspace(workspaceId: number): Promise<{ payload: Record<string, unknown> }>;
}

/** One leaf-level mismatch between compiled and fetched, after normalization. */
export interface DiffLine {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** Round-trip outcome for a single authored object. */
export interface RoundTripEntry {
  /** Payload kind the object belongs to (e.g. "dbo", "function"). */
  kind: string;
  name: string;
  status: "match" | "diff" | "missing" | "ambiguous";
  diffs: DiffLine[];
  /** The persisted JSON read back (kept for --capture); undefined when missing. */
  fetched: unknown;
}

/** Full result of one validate run. */
export interface ValidateResult {
  /** R1: did the engine accept the import? */
  accepted: boolean;
  /** The engine's rejection message when `accepted` is false. */
  importError?: string;
  /** The imported workspace id (target for round-trip reads). */
  workspaceId: number | undefined;
  /** R2: per-function round-trip parity. */
  roundTrip: RoundTripEntry[];
  /** Imported kinds present in the bundle that the loop did not round-trip. */
  unchecked: Array<{ kind: string; count: number }>;
}

export interface ValidateLoopOptions {
  reset?: boolean;
}

/** Run import → round-trip for one compiled bundle. */
export async function runValidateLoop(
  client: LoopClient,
  bundleText: string,
  opts: ValidateLoopOptions = {},
): Promise<ValidateResult> {
  const bundle = JSON.parse(bundleText) as { payload?: Record<string, unknown> };
  const payload = bundle.payload ?? {};

  let imported: ImportResult;
  try {
    imported = await client.importBundle(bundleText, { reset: opts.reset ?? true });
  } catch (err) {
    return {
      accepted: false,
      importError: err instanceof Error ? err.message : String(err),
      workspaceId: undefined,
      roundTrip: [],
      unchecked: [],
    };
  }

  const workspaceId = imported.workspaceId;
  // Registered kinds actually present on the compiled (bundle) side.
  const present = ROUND_TRIP_KINDS.map((k) => ({ kind: k.key, compiled: asRecords(payload[k.key]) })).filter(
    (p) => p.compiled.length > 0,
  );

  // Without a workspace id (can't read anything back), or with no registered
  // authored kinds to round-trip, we accepted the import but skip the export
  // entirely — every present kind, if any, is reported unchecked.
  if (workspaceId === undefined || present.length === 0) {
    return {
      accepted: true,
      workspaceId,
      roundTrip: [],
      unchecked: present.map((p) => ({ kind: p.kind, count: p.compiled.length })),
    };
  }

  // Export the imported workspace back as a packageExport bundle (same shape we
  // sent, full logic) and match each compiled object to its persisted twin via
  // the shared normalizer — apples-to-apples across every registered kind.
  const exported = await client.exportWorkspace(workspaceId);
  const roundTrip: RoundTripEntry[] = [];
  const unchecked: Array<{ kind: string; count: number }> = [];

  for (const { kind, compiled } of present) {
    const fetched = asRecords(exported.payload[kind]);
    // The export doesn't surface this kind as a populated top-level array (e.g.
    // `tool`, persisted nested under `toolset`): demote the whole kind to
    // unchecked rather than emit a false `missing` per compiled object (R3).
    if (fetched.length === 0) {
      unchecked.push({ kind, count: compiled.length });
      continue;
    }
    const index = indexByIdentity(fetched);
    for (const obj of compiled) {
      const name = typeof obj.name === "string" ? obj.name : "(unnamed)";
      const match = resolveMatch(obj, index);
      if (match.outcome !== "found") {
        // "missing" or "ambiguous" — the outcome IS the status; no fetched body.
        roundTrip.push({ kind, name, status: match.outcome, diffs: [], fetched: undefined });
      } else {
        const diffs = deepDiff(normalize(obj), normalize(match.fetched));
        roundTrip.push({ kind, name, status: diffs.length === 0 ? "match" : "diff", diffs, fetched: match.fetched });
      }
    }
  }

  return { accepted: true, workspaceId, roundTrip, unchecked };
}

/**
 * The names eligible for a `--runtime` smoke-run: entries of a runnable kind
 * (per the registry — only `function` today) that actually imported (status
 * match/diff). Tables and other non-runnable kinds are not invocable via the
 * function/run route, and missing/ambiguous names never landed. Extracted as a
 * pure helper so the gate is unit-testable (it is command behavior, not loop
 * behavior) and reads the registry instead of hardcoding a kind string.
 */
export function runnableFunctionNames(entries: RoundTripEntry[]): string[] {
  return entries
    .filter((e) => kindIsRunnable(e.kind) && (e.status === "match" || e.status === "diff"))
    .map((e) => e.name);
}

/** Coerce a payload array to records; tolerates a missing/non-array value. */
function asRecords(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((o): o is Record<string, unknown> => o !== null && typeof o === "object") : [];
}

/**
 * Leaf-level deep diff of two normalized values. Returns one entry per mismatched
 * leaf (empty array = equal). Both sides are already normalized, so a difference
 * is either a strip-rule gap or a real encoder divergence — the caller decides.
 */
export function deepDiff(expected: unknown, actual: unknown, path = "$"): DiffLine[] {
  if (expected === actual) return [];
  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object";
  if (!bothObjects) return [{ path, expected, actual }];

  const expIsArr = Array.isArray(expected);
  const actIsArr = Array.isArray(actual);
  if (expIsArr !== actIsArr) return [{ path, expected, actual }];

  // Both flags in the condition so TS narrows `expected` AND `actual` to arrays.
  if (expIsArr && actIsArr) {
    const len = Math.max(expected.length, actual.length);
    const out: DiffLine[] = [];
    for (let i = 0; i < len; i++) out.push(...deepDiff(expected[i], actual[i], `${path}[${i}]`));
    return out;
  }

  const e = expected as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
  const out: DiffLine[] = [];
  for (const k of keys) out.push(...deepDiff(e[k], a[k], `${path}.${k}`));
  return out;
}
