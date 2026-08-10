/**
 * Export-time guards for authoring shapes that can only produce a failed
 * deploy.
 *
 * The bar for a guard here is deliberately high, and it is NOT "the engine
 * currently rejects this" — most of the audit's engine-class findings are bugs
 * in a single engine code path, against shapes the engine's own tooling emits.
 * Blocking those would disable a supported feature and have to be un-shipped
 * the moment the engine is fixed. They are labelled `external` on the tracker
 * and carry a regression test in `test/workspace/diagnostics.test.ts` asserting
 * NO diagnostic fires: `useXdo: true` (#214), a `.` in a query name (#227) and
 * `idType: "uuid"` (#205).
 *
 * What clears the bar is the case where the cost is not a rejected request but
 * a **half-applied destructive import**, and where refusing it takes no
 * supported capability away.
 *
 * Every rule below is settled by a live deploy against a fresh ephemeral, not
 * by reading the engine. That distinction is load-bearing here: the engine
 * source *looks* as though it handles these columns (the runtime dbo config
 * registers an array/JSON cast for each, and the array cast renders a Postgres
 * literal string before binding), yet the content-import path fails on all of
 * them anyway. Source is the wrong oracle for this class of question.
 */
import { tableColumns } from "../kinds/table.js";
import type { ColumnDef, TableDef } from "../kinds/table.js";
import type { DiagnosticBag } from "./diagnostics.js";

/**
 * Stored column types whose presence kills the seed import (#195).
 *
 * Established by deploying one seeded table per shape to its own fresh
 * ephemeral: `{ array: true }`, `obj`, `json` and `vector` each fail the import
 * with `Array to string conversion`; `geo_*` and scalars deploy. The same
 * columns import fine on an UNSEEDED table, which is what scopes this guard.
 */
const NON_SCALAR_TYPES = new Set(["json", "obj", "vector"]);

/** Why a column counts as non-scalar, phrased as the authoring call. */
function nonScalarReason(col: ColumnDef): string | undefined {
  if (col.array === true) return "`{ array: true }`";
  if (col.type === "json") return "`f.json()`";
  if (col.type === "obj") return "`f.object({ … })`";
  if (col.type === "vector") return "`f.vector(N)`";
  return NON_SCALAR_TYPES.has(col.type) ? `\`${col.type}\`` : undefined;
}

/**
 * A seeded table may not declare a non-scalar column (#195).
 *
 * Declaring one is fine and stays supported — the column imports, reads back,
 * and is not refused here. SEEDING such a table is not: the content import dies
 * on the insert, so the deploy fails *after* the full-replace has cleared the
 * workspace. That is the one outcome worth refusing before an environment is
 * touched, and the author cannot see it coming — the offending column need not
 * appear in any seed row.
 *
 * The check is therefore on the table's SCHEMA, not on its rows: omitting the
 * column from every row is not an escape, because the engine still writes its
 * (non-scalar) empty default. Verified live — a seeded `f.geo.point()` table
 * deploys, so geo is deliberately excluded rather than swept in.
 */
function checkSeededNonScalar(def: TableDef, bag: DiagnosticBag): void {
  if (def.seed === undefined) return;
  for (const col of tableColumns(def)) {
    const reason = nonScalarReason(col);
    if (reason === undefined) continue;
    bag.error(
      "table.seed-non-scalar",
      `table "${def.name}", column "${col.name}": a table with a non-scalar column (${reason}) ` +
        `cannot be seeded. The engine's content import rejects the insert — including when no ` +
        `seed row mentions the column, because its empty default is still non-scalar — and it ` +
        `fails AFTER the full replace has cleared the workspace. Drop the \`seed\`, or move the ` +
        `non-scalar column onto a separate unseeded table and populate it from an endpoint. The ` +
        `column itself is fine to declare on an unseeded table; this is an engine limitation on ` +
        `writes, not a SideStep one.`,
    );
  }
}

/** Run every hard guard over the registered tables. */
export function checkTables(tables: readonly TableDef[], bag: DiagnosticBag): void {
  for (const def of tables) checkSeededNonScalar(def, bag);
}
