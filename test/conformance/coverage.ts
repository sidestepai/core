/**
 * Coverage report (U11). Measures how much of the Xano contract sidestep can
 * currently encode — registered object kinds and statement surfaces — so "1:1"
 * is a number, not a claim. Totals reflect the engine catalog sizes confirmed
 * during research (24 object kinds, 214 statement schema files).
 *
 * Statements are counted by **authoring surface** = one entry per engine
 * statement schema file. Two file-pairs share a stored name (so the catalog has
 * fewer unique stored names than files): `function.run`/`service.function.run`
 * → `mvp:function`, and `util.get_raw_input`/`util.get_input` → `mvp:get_input`.
 * A surface is "covered" when its stored name has a registered factory and the
 * surface is reachable through the `s` authoring tree.
 */
import { isRegisteredKind } from "../../src/kinds/kind.js";
import { isRegisteredStatement } from "../../src/statements/statement.js";
import {
  STATEMENT_SURFACES,
  TOTAL_STATEMENTS,
  IMPLEMENTED_STATEMENTS,
} from "../../src/statements/surfaces.js";

// The canonical surface catalog now lives in `src` (it's SDK metadata that also
// drives the agent-grounding manifest); re-exported here for the coverage tests.
export { STATEMENT_SURFACES, TOTAL_STATEMENTS, IMPLEMENTED_STATEMENTS };

/** Engine catalog sizes (cloud-client: script/kind/schema/{core,statement}). */
export const TOTAL_OBJECT_KINDS = 24;

/** Object kinds sidestep implements (each registered + tested). */
export const IMPLEMENTED_KINDS = [
  "function",
  "trigger",
  "tool",
  "toolset",
  "table",
  "query",
  "api_group",
  "task",
  "middleware",
  "addon",
  "workspace",
];

export interface CoverageReport {
  kinds: { implemented: number; total: number; registered: string[]; missing: string[] };
  statements: { implemented: number; total: number; registered: string[]; missing: string[] };
}

export function computeCoverage(): CoverageReport {
  const kRegistered = IMPLEMENTED_KINDS.filter(isRegisteredKind);
  const kMissing = IMPLEMENTED_KINDS.filter((k) => !isRegisteredKind(k));
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
  return [
    `Object kinds: ${r.kinds.implemented}/${r.kinds.total} (${pct(r.kinds.implemented, r.kinds.total)}%)`,
    `Statements:   ${r.statements.implemented}/${r.statements.total} (${pct(r.statements.implemented, r.statements.total)}%)`,
  ].join("\n");
}
