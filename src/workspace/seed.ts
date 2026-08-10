/**
 * Seed-content assembly (U2 + U3). Turns a table's authored `seed` rows into the
 * signed `content/<table-guid>-<page>.json` archive entries the workspace-import
 * transport inserts on deploy.
 *
 * The engine parses each content file's `payload` (a plain row array) against the
 * table's schema and inserts the rows in the import transaction — and it swallows
 * per-row errors silently. So the loud validation lives HERE: a row with an
 * unknown column or an un-coercible value is a hard build-time error naming the
 * table, row index, and column, rather than data that vanishes on deploy.
 *
 * Node-only in practice: this is invoked from the deploy/compile path, never from
 * the browser-safe `export()` — that's what keeps seed VALUES out of any frontend
 * bundle (a table def's `seed` may be a deferred thunk resolved only here).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TableDef, ColumnDef, SeedRow, SeedSource } from "../kinds/table.js";
import { SEED_FILE, isSeedFileSource, tableColumns } from "../kinds/table.js";
import { resolveRef } from "../refs/guid.js";
import { buildContentEnvelope } from "./export.js";

/**
 * One archive member (structurally an `ArchiveEntry`): its in-archive path and
 * the serialized signed `type:"content"` envelope written there.
 */
export interface SeedContentFile {
  /** `content/<table-guid>-<page>.json` (page 1-based, contiguous). */
  name: string;
  /** The serialized signed `type:"content"` envelope. */
  content: string;
}

/**
 * Target size for one content page's row array, in bytes of coerced JSON. The
 * import reads pages `1..N` per table until one is missing, so splitting a large
 * seed across pages keeps any single archive entry bounded. A page always holds
 * at least one row (a single row larger than the budget still ships whole).
 */
export const SEED_PAGE_TARGET_BYTES = 512 * 1024;

/**
 * Resolve a {@link SeedSource} (array, thunk, or async thunk) to its rows.
 *
 * A dynamic `import()` of a JSON file — `seed: () => import("./seed.json")`, the
 * form the docs recommend — resolves to a MODULE NAMESPACE, not the array: the
 * rows are on `.default`. TypeScript types `import("./x.json")` as the JSON shape
 * itself, so the thunk type-checks and only the runtime disagrees. Unwrap it here
 * (issue #164) rather than making every author remember `.then(m => m.default)`.
 */
export async function resolveSeedRows(source: SeedSource): Promise<SeedRow[]> {
  if (isSeedFileSource(source)) return readSeedFile(source[SEED_FILE]);
  const resolved = typeof source === "function" ? await source() : source;
  const rows = Array.isArray(resolved) ? resolved : unwrapDefaultExport(resolved);
  if (!Array.isArray(rows)) {
    throw new Error(`seed source did not resolve to an array of rows (got ${typeof resolved}).`);
  }
  return rows as SeedRow[];
}

/**
 * Read and parse a {@link seedFile} reference.
 *
 * Synchronous `node:fs` on purpose: this module is reached only from the
 * deploy/compile path, never from the browser-safe entry, which is the whole
 * point of naming the file by path instead of importing it.
 *
 * Every failure names the RESOLVED absolute path. `path` is written relative to
 * the declaring module, so when it is wrong the author needs to see what it
 * resolved to, not what they typed.
 */
function readSeedFile(ref: { path: string; base: string }): SeedRow[] {
  const where = `seedFile("${ref.path}")`;
  // `base` is `import.meta.url` in every documented use, but tolerate a plain
  // filesystem path rather than failing on a URL parse the author can't read.
  const base = /^[a-z][a-z0-9+.-]*:/i.test(ref.base) ? ref.base : pathToFileURL(ref.base).href;
  const file = fileURLToPath(new URL(ref.path, base));

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(
      `${where}: cannot read "${file}". The path is resolved relative to the module that ` +
        `declares the table (the \`import.meta.url\` you passed as \`base\`).`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${where}: "${file}" is not valid JSON — ${(cause as Error).message}`, {
      cause,
    });
  }

  const rows = Array.isArray(parsed) ? parsed : unwrapDefaultExport(parsed);
  if (!Array.isArray(rows)) {
    throw new Error(
      `${where}: "${file}" must hold an array of seed rows (got ${typeof parsed}).`,
    );
  }
  return rows as SeedRow[];
}

/** The `default` export of a module namespace, when it holds the row array. */
function unwrapDefaultExport(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const fallback = (value as { default?: unknown }).default;
  return Array.isArray(fallback) ? fallback : value;
}

/**
 * Coerce one column value to its wire form, or throw a located error. Grouped
 * scalar types (`int`/`decimal`, the string family) share a case; unknown/exotic
 * types (`json`, `geo_*`, `vector`, `enum`, `blob_*`, …) fall through to the
 * default and ship their JSON value as-authored, since the engine accepts the
 * stored JSON form directly.
 */
function coerceScalarValue(
  label: string,
  column: string,
  type: string,
  value: unknown,
): unknown {
  // Null is always allowed through — nullability is the engine's to enforce, and
  // a genuinely non-nullable column rejects it there. Blocking here would be a
  // guess about column config this layer doesn't fully model.
  if (value === null) return null;
  switch (type) {
    case "int":
    case "decimal": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
      }
      throw located(label, column, type, value, "a number");
    }
    case "epochms": {
      // Timestamps store as epoch-ms. Accept a number (ms), a Date, or a
      // parseable date string; reject anything else loudly.
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (value instanceof Date) return value.getTime();
      if (typeof value === "string") {
        const ms = Date.parse(value);
        if (Number.isFinite(ms)) return ms;
      }
      throw located(label, column, type, value, "an epoch-ms number, a Date, or a date string");
    }
    case "bool": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      throw located(label, column, type, value, "a boolean");
    }
    case "text":
    case "uuid":
    case "email":
    case "password": {
      if (typeof value === "string") return value;
      throw located(label, column, type, value, "a string");
    }
    default:
      return value;
  }
}

/**
 * Coerce one column value, honoring an `array` column: an array-typed column
 * expects an array (or null) and each element is coerced by the base type;
 * a scalar column coerces the value directly. A non-array value for an array
 * column (or vice-versa) throws, named by column (and element index).
 */
function coerceColumnValue(label: string, col: ColumnDef, value: unknown): unknown {
  if (value === null) return null;
  if (col.array) {
    if (!Array.isArray(value)) throw located(label, col.name, `${col.type}[]`, value, "an array");
    return value.map((el, j) => coerceScalarValue(label, `${col.name}[${j}]`, col.type, el));
  }
  return coerceScalarValue(label, col.name, col.type, value);
}

function located(
  label: string,
  column: string,
  type: string,
  value: unknown,
  expected: string,
): Error {
  const got = value instanceof Date ? "Date" : Array.isArray(value) ? "array" : typeof value;
  return new Error(
    `${label}, column "${column}" (${type}): expected ${expected}, got ${got} ` +
      `(${JSON.stringify(value)}). Fix the seed value or the column type.`,
  );
}

/**
 * Validate + coerce seed rows against a table's columns (U2). Every row must be a
 * plain object whose keys are all declared columns; each value is coerced to its
 * column's wire form. Unknown columns and un-coercible values throw, named by
 * table + row index + column — the loud counterpart to the engine's silent
 * per-row drop. Omitted columns are left absent (the engine applies its default).
 */
export function coerceSeedRows(
  tableName: string,
  columns: ColumnDef[],
  rows: readonly SeedRow[],
): Record<string, unknown>[] {
  const colByName = new Map(columns.map((c) => [c.name, c]));
  const coerced = rows.map((row, i) => {
    const label = `table "${tableName}", seed row ${i}`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${label}: expected a row object, got ${Array.isArray(row) ? "array" : typeof row}.`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      // An explicit `undefined` (e.g. from spreading an optional field) is treated
      // as an omitted column, matching JSON.stringify — not a coercion error.
      if (value === undefined) continue;
      const col = colByName.get(key);
      if (col === undefined) {
        const known = columns.map((c) => c.name).join(", ");
        throw new Error(
          `${label}: unknown column "${key}" (not in table schema). Known columns: ${known}.`,
        );
      }
      out[key] = coerceColumnValue(label, col, value);
    }
    return out;
  });
  assignIntPrimaryKeys(tableName, columns, coerced);
  return coerced;
}

/**
 * Fill the `id` of int-PK seed rows that omit it. The content-import path
 * PRESERVES each row's `id` and never auto-assigns one (a genuine engine export
 * always carries `id`), so id-less rows would all insert as the same key and the
 * import 500s with "Duplicate record detected". Verified against a live engine.
 *
 * For an int primary key we auto-number omitted rows `1..N` so `seed: [{...}, …]`
 * just works; the engine resets the PK sequence past the max on import. All-or-
 * nothing: a mix of explicit and omitted `id` is ambiguous (which numbers are
 * free?) and throws. Non-int PKs (uuid) and `system:false` tables are left alone —
 * the engine generates uuids, and a custom PK is the author's to supply.
 */
function assignIntPrimaryKeys(
  tableName: string,
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
): void {
  const idCol = columns.find((c) => c.name === "id");
  if (idCol?.type !== "int") return;
  const withId = rows.filter((r) => r.id !== undefined).length;
  if (withId === rows.length) return; // all explicit — nothing to fill
  if (withId !== 0) {
    throw new Error(
      `table "${tableName}": ${withId} of ${rows.length} seed rows set \`id\` and the rest omit it. ` +
        `The engine preserves seed ids and won't auto-fill a missing one, so a mix collides on the ` +
        `primary key. Provide \`id\` for every seed row, or none (they'll be auto-numbered 1..N).`,
    );
  }
  rows.forEach((r, i) => {
    r.id = i + 1;
  });
}

/** Split coerced rows into pages under {@link SEED_PAGE_TARGET_BYTES} (≥1 row/page). */
export function paginateRows(
  rows: Record<string, unknown>[],
  budgetBytes = SEED_PAGE_TARGET_BYTES,
): Record<string, unknown>[][] {
  const pages: Record<string, unknown>[][] = [];
  let page: Record<string, unknown>[] = [];
  let size = 0;
  for (const row of rows) {
    // A cheap plain-JSON sizing stringify — intentionally NOT the PHP-shaped
    // signature encoder. Keep it separate: folding it into the signer would
    // couple page sizing to byte-exact signing and risk breaking either.
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (page.length > 0 && size + rowBytes > budgetBytes) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(row);
    size += rowBytes;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/**
 * Build every seed `content/` archive entry for a set of table defs (U3). For
 * each table carrying `seed`, resolve → coerce → paginate → sign, keying files by
 * the table's `dbo` guid (`resolveRef("dbo", def)`, lock-aware — matches the guid
 * the same table emits in `workspace.json`). Tables with no seed, or an empty
 * resolved seed, contribute nothing.
 *
 * Must run in the same process/lock context as the workspace export so guids line
 * up. Async because a {@link SeedSource} thunk may be async (e.g. a dynamic
 * import of a seed file).
 */
export async function buildSeedContentFiles(tableDefs: readonly TableDef[]): Promise<SeedContentFile[]> {
  const files: SeedContentFile[] = [];
  for (const def of tableDefs) {
    if (def.seed === undefined) continue;
    const rows = await resolveSeedRows(def.seed);
    if (rows.length === 0) continue;
    const coerced = coerceSeedRows(def.name, tableColumns(def), rows);
    const guid = resolveRef("dbo", def);
    const pages = paginateRows(coerced);
    pages.forEach((page, i) => {
      files.push({ name: `content/${guid}-${i + 1}.json`, content: JSON.stringify(buildContentEnvelope(page)) });
    });
  }
  return files;
}

/** A seed value the schema says is not public, and where it came from. */
export interface NonPublicSeedValue {
  table: string;
  column: string;
  value: string;
}

/**
 * Minimum length for a value worth scanning a built frontend for.
 *
 * Below this the string is more likely to collide with ordinary bundle content
 * (a status word, an initial) than to be the secret it came from, and a guard
 * that cries wolf gets switched off.
 */
const MIN_SCANNABLE_LENGTH = 6;

/**
 * Seed values drawn from columns the schema itself declares non-public.
 *
 * Scoped deliberately. A PUBLIC column's seed value is already readable through
 * the deployed API, so finding it in a static bundle discloses nothing new and
 * refusing on it would be noise. What matters is a value the schema says never
 * leaves the server:
 *
 *   • `access: "internal"` — omitted from API output entirely (`f.password`'s
 *     default), so the plaintext exists ONLY in the seed file and in whatever a
 *     bundler copied it into.
 *   • `sensitive: true` — the author's explicit "do not surface this".
 *
 * `access: "private"` is NOT included: private columns are still returned in
 * responses (the system `created_at` is private and comes back on every read),
 * so they carry no additional exposure here.
 */
export async function collectNonPublicSeedValues(
  tableDefs: readonly TableDef[],
): Promise<NonPublicSeedValue[]> {
  const found: NonPublicSeedValue[] = [];
  for (const def of tableDefs) {
    if (def.seed === undefined) continue;
    const guarded = tableColumns(def).filter(
      (col) => col.access === "internal" || col.sensitive === true,
    );
    if (guarded.length === 0) continue;
    const rows = await resolveSeedRows(def.seed);
    for (const row of rows) {
      for (const col of guarded) {
        const value = (row as Record<string, unknown>)[col.name];
        if (typeof value !== "string" || value.length < MIN_SCANNABLE_LENGTH) continue;
        found.push({ table: def.name, column: col.name, value });
      }
    }
  }
  return found;
}
