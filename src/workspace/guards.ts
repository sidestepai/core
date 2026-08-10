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

/** An engine object guid: 32 lowercase hex characters. */
const GUID_RE = /^[0-9a-f]{32}$/;

/**
 * Keys whose subtrees carry AUTHOR VALUES, never object references.
 *
 * A reference is structural — the encoder puts it there. Anything under these
 * keys came from the author, so a 32-hex string in one is a coincidence, not a
 * dangling pointer. This is not hypothetical: `examples/sandbox` has an
 * auth-token example whose statement input value is a literal 32-hex string.
 * Skipping these subtrees is what lets the check be an ERROR rather than a
 * warning nobody trusts.
 */
const VALUE_KEYS = new Set([
  "input",
  "value",
  "default",
  "filters",
  "search",
  "docs",
  "description",
  "mocks",
  "tag",
  "settings_registry",
  // An object's own identity, not a pointer at another object.
  "guid",
]);

/**
 * Reference keys whose target legitimately lives OUTSIDE the workspace, so an
 * unresolved guid is expected rather than a mistake. `run_version` is a
 * marketplace action-package version — installed on the instance, never part of
 * a bundle SideStep emits.
 */
const EXTERNAL_REF_KEYS = new Set(["run_version"]);

/** One dangling reference: where it was found and what it points at. */
interface DanglingRef {
  readonly owner: string;
  readonly path: string;
  readonly guid: string;
}

/** Collect every guid-valued reference under `node` that resolves to nothing. */
function collectDanglingRefs(
  node: unknown,
  path: string,
  owner: string,
  known: ReadonlySet<string>,
  out: DanglingRef[],
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectDanglingRefs(item, `${path}[${i}]`, owner, known, out));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (VALUE_KEYS.has(key) || EXTERNAL_REF_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (GUID_RE.test(value) && !known.has(value)) {
        out.push({ owner, path: `${path}.${key}`, guid: value });
      }
      continue;
    }
    collectDanglingRefs(value, `${path}.${key}`, owner, known, out);
  }
}

/**
 * Every cross-object reference must name an object this bundle emits.
 *
 * A reference is stored as the target's guid, and `resolveRef` derives that
 * guid from a name with **no registry visibility** — so `s.addon.call({ addon:
 * "ex_author_addon" })` against an addon actually named `ex_kind_author_addon`
 * produces a perfectly well-formed guid pointing at nothing. It exports clean
 * and then fails the import with `Invalid addon reference. Try importing:
 * <guid>`, after the full replace has begun. The author is handed a guid, which
 * is exactly the thing they cannot map back to their typo.
 *
 * `export()` already cross-checked one reference kind (a query's `auth` table)
 * and nothing else. This generalises it: the registry is fully known here, so
 * every reference is checkable. Five of these were live in `examples/sandbox`.
 *
 * Scoped to the full `workspace` bundle, which is what `deploy` ships and which
 * must be self-contained. A partial bundle (`schema`/`content`/`share`) may
 * legitimately reference an object it does not carry.
 */
export function checkReferences(
  bundleType: string,
  sections: Readonly<Record<string, unknown[] | undefined>>,
  workspaceGuid: unknown,
  bag: DiagnosticBag,
): void {
  if (bundleType !== "workspace") return;

  const known = new Set<string>();
  if (typeof workspaceGuid === "string") known.add(workspaceGuid);
  for (const arr of Object.values(sections)) {
    for (const obj of arr ?? []) {
      const guid = (obj as { guid?: unknown })?.guid;
      if (typeof guid === "string") known.add(guid);
    }
  }

  const dangling: DanglingRef[] = [];
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const name = (obj as { name?: unknown }).name;
      const owner = `${payloadKey} "${typeof name === "string" ? name : "?"}"`;
      collectDanglingRefs(obj, "$", owner, known, dangling);
    }
  }

  // One diagnostic per distinct target: a single mistyped name referenced from
  // three statements is one thing to fix, not three.
  const byGuid = new Map<string, DanglingRef[]>();
  for (const ref of dangling) {
    const bucket = byGuid.get(ref.guid);
    if (bucket) bucket.push(ref);
    else byGuid.set(ref.guid, [ref]);
  }

  for (const [guid, refs] of byGuid) {
    const owners = [...new Set(refs.map((r) => r.owner))];
    const from =
      owners.length === 1
        ? owners[0]!
        : `${owners.slice(0, 3).join(", ")}${owners.length > 3 ? `, +${owners.length - 3} more` : ""}`;
    bag.error(
      "reference.unresolved",
      `${from} references an object that is not registered on this workspace (guid ${guid}). ` +
        `A reference is resolved to a guid from the target's NAME with no registry lookup, so a ` +
        `mistyped name produces a valid-looking guid that only fails at deploy — ` +
        `"Invalid <kind> reference. Try importing: ${guid}" — after the import has begun. Check ` +
        `the name for a typo and register the target; pass the def handle rather than a bare ` +
        `name so a rename cannot silently break the reference. Reference found at ${refs[0]!.path}.`,
    );
  }
}
