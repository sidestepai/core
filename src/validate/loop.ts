/**
 * The `sidestep validate` loop: import a compiled JSON bundle into a live
 * instance, then read each authored object back and diff it against what we
 * compiled (KTD-1/2). Acceptance of the real import is the R1 proof; the
 * per-object JSON diff is R2.
 *
 * Pure orchestration: it takes an already-serialized bundle and a client, so it
 * carries no file IO or module loading and is unit-testable with a fake client.
 * Round-trip parity is checked for functions (the fixture-capture core); other
 * imported kinds are reported as present-but-unchecked rather than silently
 * treated as covered.
 */
import { normalize } from "./normalize.js";
import type { ImportResult } from "./meta-client.js";

/** The client surface the loop needs (satisfied structurally by MetaClient). */
export interface LoopClient {
  importBundle(bundle: string, opts?: { reset?: boolean }): Promise<ImportResult>;
  listFunctions(workspaceId: number): Promise<Array<{ id: number; name: string | undefined }>>;
  getFunction(workspaceId: number, functionId: number): Promise<unknown>;
}

/** One leaf-level mismatch between compiled and fetched, after normalization. */
export interface DiffLine {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** Round-trip outcome for a single authored function. */
export interface RoundTripEntry {
  name: string;
  status: "match" | "diff" | "missing";
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

/** Bundle payload keys the loop does not (yet) round-trip, for honest reporting. */
const UNCHECKED_KINDS = ["dbo", "addon", "middleware", "trigger", "task", "query", "tool", "toolset"];

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
  const compiledFns = asRecords(payload.function);
  const unchecked = UNCHECKED_KINDS.map((kind) => ({ kind, count: asRecords(payload[kind]).length })).filter(
    (u) => u.count > 0,
  );

  // Without a workspace id we accepted the import but cannot read anything back.
  if (workspaceId === undefined) {
    return { accepted: true, workspaceId, roundTrip: [], unchecked };
  }

  let roundTrip: RoundTripEntry[] = [];
  if (compiledFns.length > 0) {
    const persisted = await client.listFunctions(workspaceId);
    const idByName = new Map(persisted.filter((f) => f.name !== undefined).map((f) => [f.name!, f.id]));
    // Reads are independent (each keyed by an already-resolved id), so fetch +
    // diff them concurrently; Promise.all preserves the authored order.
    roundTrip = await Promise.all(
      compiledFns.map(async (fn): Promise<RoundTripEntry> => {
        const name = typeof fn.name === "string" ? fn.name : "(unnamed)";
        const id = idByName.get(name);
        if (id === undefined) return { name, status: "missing", diffs: [], fetched: undefined };
        const fetched = await client.getFunction(workspaceId, id);
        const diffs = deepDiff(normalize(fn), normalize(fetched));
        return { name, status: diffs.length === 0 ? "match" : "diff", diffs, fetched };
      }),
    );
  }

  return { accepted: true, workspaceId, roundTrip, unchecked };
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
