/**
 * Coverage report (U11). Measures how much of the Xano contract sidestep can
 * currently encode — authorable object kinds and statement surfaces — so "1:1"
 * is a number, not a claim. Both totals are the engine's own catalog sizes, and
 * the kind catalog is enumerated in `src/manifest/manifest.ts` rather than
 * restated as a literal here.
 *
 * Statements are counted by **authoring surface** = one entry per engine
 * statement schema file. One file-pair shares a stored name (so the catalog has
 * one fewer unique stored name than files): `util.get_raw_input`/`util.get_input`
 * → `mvp:get_input`.
 * A surface is "covered" when its stored name has a registered factory and the
 * surface is reachable through the `s` authoring tree.
 */
import { isRegisteredKind } from "../../src/kinds/kind.js";
import {
  IMPLEMENTED_OBJECT_KINDS,
  KIND_DESCRIPTORS,
  TOTAL_OBJECT_KINDS as ENGINE_TOTAL_OBJECT_KINDS,
  unmodeledObjectKinds,
} from "../../src/manifest/manifest.js";
import { isRegisteredStatement } from "../../src/statements/statement.js";
import {
  STATEMENT_SURFACES,
  TOTAL_STATEMENTS,
  IMPLEMENTED_STATEMENTS,
} from "../../src/statements/surfaces.js";

// The canonical surface catalog now lives in `src` (it's SDK metadata that also
// drives the agent-grounding manifest); re-exported here for the coverage tests.
export { STATEMENT_SURFACES, TOTAL_STATEMENTS, IMPLEMENTED_STATEMENTS };

/**
 * Engine catalog sizes and the implemented set both come from the SDK's own
 * enumerated kind catalog now. They used to be restated here, and drifted: this
 * file's list was missing `microservice`, so the conformance report said 15/30
 * while the manifest said 16/30 and the floor assertion below compared a stale
 * list against itself. A second copy of a number is a second answer.
 */
export const TOTAL_OBJECT_KINDS = ENGINE_TOTAL_OBJECT_KINDS;

/** Engine object kinds sidestep implements — one entry per ENGINE kind. */
export const IMPLEMENTED_KINDS: readonly string[] = IMPLEMENTED_OBJECT_KINDS.map((k) => k.kind);

export interface CoverageReport {
  kinds: { implemented: number; total: number; registered: string[]; missing: string[] };
  statements: { implemented: number; total: number; registered: string[]; missing: string[] };
}

export function computeCoverage(): CoverageReport {
  // Engine kinds are the unit of coverage; the live-registry check runs over the
  // SDK kinds that back them, since one SDK kind (`trigger`) answers for seven
  // engine kinds and `table_trigger` is not a name the registry has ever held.
  const kRegistered = [...IMPLEMENTED_KINDS];
  const kMissing = KIND_DESCRIPTORS.filter((d) => !isRegisteredKind(d.kind)).map((d) => d.kind);
  const sRegistered = STATEMENT_SURFACES.filter(([, name]) => isRegisteredStatement(name)).map(
    ([key]) => key,
  );
  const sMissing = STATEMENT_SURFACES.filter(([, name]) => !isRegisteredStatement(name)).map(
    ([key]) => key,
  );
  return {
    kinds: {
      implemented: kRegistered.length,
      total: TOTAL_OBJECT_KINDS,
      registered: kRegistered,
      missing: kMissing,
    },
    statements: {
      implemented: sRegistered.length,
      total: TOTAL_STATEMENTS,
      registered: sRegistered,
      missing: sMissing,
    },
  };
}

export function formatCoverage(r: CoverageReport): string {
  const pct = (n: number, d: number) => ((n / d) * 100).toFixed(1);
  const unmodeled = unmodeledObjectKinds().map((k) => k.kind);
  return [
    `Object kinds: ${r.kinds.implemented}/${r.kinds.total} (${pct(r.kinds.implemented, r.kinds.total)}%)`,
    `Statements:   ${r.statements.implemented}/${r.statements.total} (${pct(r.statements.implemented, r.statements.total)}%)`,
    `Unmodeled:    ${unmodeled.join(", ")}`,
  ].join("\n");
}
