/**
 * Table (database) kind (U6) → payload key `dbo`. Columns reuse the shared
 * field encoder (KTD-6) with the column context; indexes, views, and
 * autocomplete have their own small shapes. Validated against the Xano engine's
 * persisted table shape (the full rich field-type corpus).
 */
import type { FieldXdo, ExprNode } from "../types/xdo.js";
import { encodeField, COLUMN_CONTEXT } from "../fields/field.js";
import type { FieldOptions } from "../fields/field.js";
import type { FieldMap } from "../fields/catalog.js";
import type { RowFromFieldMap, FromFieldMap, Prettify } from "../fields/value-types.js";
import { encodeComparison } from "../statements/conditional.js";
import type { Condition } from "../statements/conditional.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";

/** A column definition: a field with a name + type. */
export interface ColumnDef extends FieldOptions {
  name: string;
  type: string;
}

/**
 * A table schema is authored either as an explicit `ColumnDef[]` (raw type
 * strings) or, preferred, as a named map of catalog descriptors
 * (`{ id: f.int(), email: f.email() }`).
 */
export type SchemaDef = ColumnDef[] | FieldMap;

/**
 * Index kind (per the engine's index schema): `primary`/`btree` (+`btree|unique`) on
 * columns, `gin` on the internal JSON, `search` (full-text), `gist` (spatial),
 * `vector`. Open-ended (`string & {}`) since the stored layer accepts variants
 * (e.g. `gin|unique`) the authoring DSL doesn't enumerate.
 *
 * `"unique"` is accepted as an ergonomic shorthand for `"btree|unique"` (the
 * literal the engine requires); it is normalized on export. See
 * {@link normalizeIndexType}.
 */
export type IndexType =
  | "primary"
  | "btree"
  | "btree|unique"
  | "unique"
  | "gin"
  | "search"
  | "gist"
  | "vector"
  | (string & {});

/**
 * Map author-facing index-type shorthands to the literal the Xano engine
 * accepts. Today just `"unique"` → `"btree|unique"`: `"unique"` is the obvious
 * thing to write and type-checks (the union ends in `string & {}`), but the
 * engine rejects it at import with an opaque `Invalid index type.` 500. Applied
 * everywhere a type is compared or serialized so dedup and export agree.
 */
export function normalizeIndexType(type: IndexType): string {
  return type === "unique" ? "btree|unique" : type;
}

/**
 * Per-field index operator: `asc`/`desc` (btree), `jsonb_path_op` (gin),
 * `gist_geometry_ops_2d` (spatial), or a pgvector distance op (vector indexes).
 */
export type IndexOp =
  | "asc"
  | "desc"
  | "jsonb_path_op"
  | "gist_geometry_ops_2d"
  | "vector_ip_ops"
  | "vector_cosine_ops"
  | "vector_l1_ops"
  | "vector_l2_ops"
  | (string & {});

/** Full-text-search index language (per the engine's search-index schema). */
export type IndexLang =
  | "simple"
  | "arabic"
  | "danish"
  | "dutch"
  | "english"
  | "finnish"
  | "french"
  | "german"
  | "hungarian"
  | "indonesian"
  | "irish"
  | "italian"
  | "lithuanian"
  | "nepali"
  | "norwegian"
  | "portuguese"
  | "romanian"
  | "russian"
  | "spanish"
  | "swedish"
  | "tamil"
  | "turkish"
  | (string & {});

/** A database index definition. */
export interface IndexDef {
  type: IndexType;
  fields: Array<{ name: string; op?: IndexOp }>;
  name?: string;
  lang?: IndexLang;
}

/** A table view: a saved, filtered/sorted projection of the table. */
export interface ViewDef {
  name: string;
  /** Stable view id (uuid). Required — the engine persists it verbatim. */
  id: string;
  alias?: string;
  /** Columns to hide in the view → stored `hiddenCols`. */
  hide?: string[];
  /** Free-text search query → stored `q`. */
  q?: string;
  /** Filter expression (reuses the conditional comparison shape). */
  where?: Condition;
  /** Sort order, applied in array order. */
  sort?: Array<{ name: string; order: "asc" | "desc" }>;
}

/**
 * The column-name union for a table authored with a {@link FieldMap} schema:
 * the declared column keys plus the auto-injected system columns. Drives
 * schema-aware statement typing (db `fieldName`/`output`/`sortBy`/`row` keys).
 */
export type SchemaCols<S extends FieldMap> = Extract<keyof S, string> | "id" | "created_at";

/**
 * The auto-injected system columns as they appear on a **row**, parameterized by
 * the table's {@link TableDef.idType}: the primary key `id` (a `number` for the
 * default `int`, a `string` for `uuid`) and the `epochms` `created_at` (always a
 * number). A `FieldMap`-schema table adds these to {@link RowOf} unless it
 * declares its own.
 */
type SystemRow<IdT extends "int" | "uuid"> = {
  id: IdT extends "uuid" ? string : number;
  created_at: number;
};

/**
 * The **row type** of a `FieldMap`-schema table — the shape a read returns: each
 * declared column (value types recovered from the field brands, `nullable`/
 * `array` applied) plus the auto-injected system columns `id`/`created_at`,
 * unless the schema declares its own. `IdT` threads the table's
 * {@link TableDef.idType} through so a `uuid` primary key infers `id: string`
 * (not `number`); `Sys` threads {@link TableDef.system} through so a
 * `system:false` table drops the injected columns (matching its narrower runtime
 * row). The read-side mirror of the request-only
 * {@link import("../inputs/infer.js").InferInput}. Recovered from a table handle
 * via {@link InferRow}.
 *
 * `Sys` is compared non-distributively (`[Sys] extends [false]`) so only a
 * literal `false` drops the columns — an unresolved `boolean` keeps them, the
 * safe default. Note {@link SchemaCols} (the column-name phantom) is unaffected
 * and still always carries `id`/`created_at`; the two intentionally diverge for
 * `system:false` (a name may still be referenced even when the read row omits it).
 *
 * This is the table's full declared row, not any one endpoint's payload — a query
 * returns whatever its `response`/`output` selects. `created_at` carries
 * `access:"private"`, which the engine excludes from a *default, auto-shaped*
 * read (it's `hidden` in the generated response), so such an endpoint omits it
 * even though this type lists it; a response that explicitly selects `created_at`
 * still returns it. Narrow with `Omit<InferRow<T>, "created_at">` on the
 * auto-shaped path if you need the payload's exact shape.
 */
export type RowOf<
  S extends FieldMap,
  IdT extends "int" | "uuid" = "int",
  Sys extends boolean = true,
> = Prettify<
  ([Sys] extends [false] ? Record<never, never> : Omit<SystemRow<IdT>, keyof S>) &
    RowFromFieldMap<S>
>;

/**
 * Recover a table's row type from a {@link table} handle:
 * `InferRow<typeof postTable>`. Closes the loop the SDK opens with `InferInput`
 * on the request side — rename or retype a column and every consumer that types
 * a row against `InferRow` lights up. A table authored with a raw `ColumnDef[]`
 * schema carries no field brands, so its row is `unknown` (nothing to infer).
 */
export type InferRow<T> = T extends TableDef<string, infer Row> ? Row : never;

/**
 * A single seed row: a plain JSON record shipped in the deploy package and
 * inserted on deploy. `Row` is the table's inferred read shape ({@link RowOf}),
 * with the auto-injected system columns made optional — `id` and `created_at`
 * carry engine defaults (auto-increment / `now`), so a seed row may omit them;
 * supplying `id` pins it (the engine preserves it and resets the PK sequence).
 * A raw-`ColumnDef[]` (unbranded) table falls back to an open record.
 */
export type SeedRow<Row = unknown> = [Row] extends [never]
  ? Record<string, unknown>
  : unknown extends Row
    ? Record<string, unknown>
    : Partial<Pick<Row & object, Extract<"id" | "created_at", keyof Row>>> &
        Omit<Row & object, "id" | "created_at">;

/**
 * The AUTHORING shape of one seed row for a {@link FieldMap} schema — a write
 * payload, not a read row: a column without `required: true` is an OPTIONAL key
 * (the engine applies its default for an absent column, and `coerceSeedRows`
 * leaves it absent), while a `required` one must be supplied. Only the injected
 * system columns are added, and those are optional too.
 *
 * Distinct from {@link RowOf}, the READ shape, where every declared column is
 * present. Using the read shape here demanded every column on every seed row —
 * stricter than both the runtime validator and the engine (issue #164).
 */
export type SeedRowOf<
  S extends FieldMap,
  IdT extends "int" | "uuid" = "int",
  Sys extends boolean = true,
> = Prettify<
  ([Sys] extends [false] ? Record<never, never> : Partial<Omit<SystemRow<IdT>, keyof S>>) &
    FromFieldMap<S>
>;

/**
 * How a table's seed rows are supplied. Either the rows directly, or — the
 * frontend-safe form — a **deferred source**: a thunk (optionally async, e.g.
 * `() => import("./seed.json")`) resolved only in the Node deploy pipeline. A
 * deferred source keeps large or sensitive seed data out of any frontend bundle
 * that value-imports the table def, and is erased entirely under `import type`.
 * Prefer the thunk form for anything beyond a handful of inline rows — it costs
 * no typing (row and column inference survive every form; issue #164).
 *
 * A JSON `import()` resolves to a module namespace at runtime, not the array
 * TypeScript types the specifier as; the deploy path unwraps `.default`, so
 * `() => import("./seed.json")` works as written.
 */
export type SeedSource<Row = unknown> =
  | ReadonlyArray<SeedRow<Row>>
  | (() => ReadonlyArray<SeedRow<Row>> | Promise<ReadonlyArray<SeedRow<Row>>>);

/**
 * @typeParam Cols - phantom column-name union, captured by {@link table} from a
 *   `FieldMap` schema so db statements can type their column-name fields against
 *   it. Defaults to `string` (a table authored with a raw `ColumnDef[]`, or a
 *   bare-name reference, stays loosely typed). Never set at runtime.
 * @typeParam Row - phantom row-type carrier, captured by {@link table} from a
 *   `FieldMap` schema so `InferRow<typeof table>` can recover the read shape.
 *   Defaults to `unknown` (a raw-schema/bare-name table carries no brands).
 *   Never set at runtime.
 */
export interface TableDef<Cols extends string = string, Row = unknown> {
  /** @internal phantom carrier for {@link Cols}; never assigned at runtime. */
  readonly __cols?: Cols;
  /** @internal phantom carrier for {@link Row}; never assigned at runtime. */
  readonly __row?: Row;
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  auth?: boolean;
  install?: boolean;
  schema: SchemaDef;
  /**
   * Auto-prepend the engine's standard system columns — `id` (int, primary key)
   * and `created_at` (epochms, `default:"now"`, `access:"private"`) — when the
   * authored schema doesn't already declare them. Default `true`; set `false`
   * for a table that owns its primary key shape (e.g. an external/imported one).
   * Columns the author *does* declare are respected and never duplicated.
   */
  system?: boolean;
  /**
   * Type of the auto-injected `id` primary key: `int` (auto-increment, the
   * default) or `uuid`. Ignored when `system:false` or when the author declares
   * their own `id` column. Only affects the system-column shape — the
   * `primary(id)` index is unchanged.
   */
  idType?: "int" | "uuid";
  /**
   * Storage mode. `true` stores every authored field as JSON under the internal
   * `xdo` column (and the engine adds a `gin(xdo)` index); `false` (the default)
   * gives each field its own real Postgres column and no `gin` index. Both look
   * identical to read — `xdo` is hidden. Mirrors the workspace-level `use_xdo`
   * setting (also `false` by default); set per-table to override. Only affects
   * physical storage + the `gin` index, never the authored schema.
   */
  useXdo?: boolean;
  /**
   * Database indexes. The engine's standard set — `primary(id)`,
   * `btree(created_at desc)`, plus `gin(xdo)` when {@link useXdo} is `true` —
   * is auto-prepended (alongside the system columns it indexes) unless
   * `system:false` or you declare an equivalent one (matched by type + covered
   * fields). Declare extras (unique, composite, …) here; they're kept verbatim
   * and the standard set rides along de-duped.
   */
  index?: IndexDef[];
  autocomplete?: string[];
  external?: { source: string; id: string };
  views?: ViewDef[];
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  /**
   * Seed rows shipped in the deploy package and inserted on deploy (full-replace
   * import → re-deploy re-seeds cleanly, no duplication). Off the table's
   * persisted schema — it rides as a separate `content/` archive entry, resolved
   * and validated **only in the Node deploy path**, never in the browser-safe
   * bundle. See {@link SeedSource}; prefer a deferred thunk for large data.
   *
   * Typed loosely here (not against `Row`) so a `TableDef<_, ConcreteRow>` stays
   * assignable to `TableDef<string, unknown>` — the {@link table} overload types
   * the authoring input against the real row shape.
   */
  seed?: SeedSource;
}

export interface IndexXdo {
  name: string;
  lang: string;
  type: string;
  fields: Array<{ name: string; op: string }>;
  market_item: { id: number; version: number; guid: string };
}

export interface ViewXdo {
  alias: string;
  hiddenCols: string[];
  id: string;
  name: string;
  q: string;
  expression: ExprNode[];
  sort: Array<{ name: string; order: string }>;
}

export interface TableXdo {
  name: string;
  description: string;
  docs: string;
  auth: boolean;
  install: boolean;
  schema: FieldXdo[];
  index: IndexXdo[];
  autocomplete: Array<{ name: string }>;
  external: { source: string; id: string };
  views: ViewXdo[];
  tag: unknown[];
  sql_name: string;
  use_xdo: boolean;
  market_item: { id: number; version: number; guid: string };
}

/** Normalize either schema authoring form into a flat `ColumnDef[]`. */
function toColumns(schema: SchemaDef): ColumnDef[] {
  if (Array.isArray(schema)) return schema;
  return Object.entries(schema).map(([name, d]) => ({ name, type: d.type, ...d.options }));
}

/**
 * The engine's standard system columns, in canonical order. Confirmed identical
 * at the head of every persisted `schema:table*` fixture: `id` is the primary
 * key (`required`, `int` by default or `uuid` via {@link TableDef.idType}),
 * `created_at` an `epochms` (stored name for `timestamp`) with `default:"now"`
 * and `access:"private"`.
 */
function systemColumns(idType: TableDef["idType"] = "int"): ColumnDef[] {
  return [
    // A uuid primary key persists NO `default` key — the engine stores it that
    // way because the value is engine-generated. An `int` key and an ordinary
    // (non-key) uuid column both carry `default: ""`, so this is specific to the
    // uuid key. See {@link FieldOptions.noDefault}.
    { name: "id", type: idType, required: true, ...(idType === "uuid" ? { noDefault: true } : {}) },
    { name: "created_at", type: "epochms", default: "now", access: "private" },
  ];
}

/**
 * The table's columns as a flat `ColumnDef[]`, regardless of authoring form,
 * with the system columns auto-prepended unless `system:false` or the author
 * already declared them. Shared by {@link encodeTable} and db row expansion so
 * both see the same column list.
 */
export function tableColumns(def: Pick<TableDef, "schema" | "system" | "idType">): ColumnDef[] {
  const cols = toColumns(def.schema);
  if (def.system === false) return cols;
  const present = new Set(cols.map((col) => col.name));
  const missing = systemColumns(def.idType).filter((sc) => !present.has(sc.name));
  return [...missing, ...cols];
}

/**
 * The engine's standard indexes, auto-created alongside a table's system
 * columns, in canonical order. Confirmed against live `mvp_dbo`: the `id`
 * primary key, then (only when `use_xdo`) a `gin` index on the internal `xdo`
 * JSON column (`jsonb_path_op`), then a descending `btree` on `created_at`. The
 * `gin(xdo)` index exists iff the table stores fields as JSON — see
 * {@link TableDef.useXdo}.
 */
function systemIndexes(useXdo = false): IndexDef[] {
  return [
    { type: "primary", fields: [{ name: "id" }] },
    ...(useXdo ? [{ type: "gin" as const, fields: [{ name: "xdo", op: "jsonb_path_op" }] }] : []),
    { type: "btree", fields: [{ name: "created_at", op: "desc" }] },
  ];
}

/** Dedup signature for an index: its type plus the ordered field names it covers. */
function indexSignature(def: IndexDef): string {
  return `${normalizeIndexType(def.type)}|${def.fields.map((field) => field.name).join(",")}`;
}

/**
 * The table's indexes, with the standard system indexes auto-prepended unless
 * `system:false` or the author already declared an equivalent one (matched by
 * type + covered field names). Mirrors {@link tableColumns}: the standard set
 * rides along with the system columns it indexes, and an author who declares
 * their own (e.g. a unique index, or a reordered set) is respected and never
 * doubled.
 */
export function tableIndexes(def: Pick<TableDef, "index" | "system" | "useXdo">): IndexDef[] {
  const declared = def.index ?? [];
  if (def.system === false) return declared;
  const present = new Set(declared.map(indexSignature));
  const missing = systemIndexes(def.useXdo).filter((idx) => !present.has(indexSignature(idx)));
  return [...missing, ...declared];
}

export function encodeIndex(def: IndexDef): IndexXdo {
  return {
    name: def.name ?? "",
    lang: def.lang ?? "",
    type: normalizeIndexType(def.type),
    fields: def.fields.map((field) => ({ name: field.name, op: field.op ?? "" })),
    market_item: { id: 0, version: 0, guid: "" },
  };
}

export function encodeView(def: ViewDef): ViewXdo {
  return {
    alias: def.alias ?? "",
    hiddenCols: def.hide ?? [],
    id: def.id,
    name: def.name,
    q: def.q ?? "",
    expression: def.where ? encodeComparison(def.where).expression : [],
    sort: (def.sort ?? []).map((s) => ({ name: s.name, order: s.order })),
  };
}

export function encodeColumn(def: ColumnDef): FieldXdo {
  const { name, type, ...options } = def;
  return encodeField(name, type, options, COLUMN_CONTEXT);
}

/**
 * Reject a 4-byte (astral-plane) column `default` at author time (issue #45).
 * The engine's default pipeline round-trips the value through a surrogate-pair
 * JSON escape (PHP `json_encode("🌱")` → `"🌱"`) and a downstream
 * decode emits the surrogate halves as invalid CESU-8 bytes, so a default with
 * a character above the BMP (codepoint > U+FFFF — emoji, CJK-extension glyphs)
 * type-checks and `export`s cleanly but 500s at `deploy` with a raw Postgres
 * `22021` (`invalid byte sequence for encoding "UTF8"`) at table-creation time —
 * same "compiles/exports but blows up later" class as issue #42. The database
 * is UTF8, so BMP characters (accents, `€`, most CJK) store fine and are *not*
 * rejected; only surrogate-pair characters break. Verified against the engine's
 * Postgres image. Column defaults only: *input* defaults bind at runtime, not as
 * DDL, so they accept any character and never reach this path.
 */
function assertBmpColumnDefault(tableName: string, col: ColumnDef): void {
  if (col.default === undefined) return;
  for (const ch of String(col.default)) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const u = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      throw new Error(
        `table "${tableName}", column "${col.name}": \`default\` contains a 4-byte ` +
          `character (${JSON.stringify(ch)}, ${u}). The engine mangles such characters ` +
          `into an invalid UTF-8 sequence in the column default, failing at deploy with ` +
          `Postgres 22021 (invalid byte sequence for encoding "UTF8"). Use a default within ` +
          `the Basic Multilingual Plane (accents, most CJK, and € are fine), or move the ` +
          `value onto an endpoint input (\`input.text({ default })\`), applied at runtime ` +
          `bind. (issue #45)`,
      );
    }
  }
}

export function encodeTable(def: TableDef): TableXdo {
  if (!def.name) throw new Error("table: `name` is required.");
  for (const col of tableColumns(def)) assertBmpColumnDefault(def.name, col);
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    auth: def.auth ?? false,
    install: def.install ?? false,
    schema: tableColumns(def).map(encodeColumn),
    index: tableIndexes(def).map(encodeIndex),
    autocomplete: (def.autocomplete ?? []).map((name) => ({ name })),
    external: def.external ?? { source: "", id: "" },
    views: (def.views ?? []).map(encodeView),
    tag: encodeTags(def.tags),
    // A table has no `as` — it returns nothing (it's a datastore, not a stack
    // statement); confirmed 0/16 live `mvp_dbo` rows carry one. (Older golden
    // export fixtures store `as:<name>`, a stale generation — see normalize.ts.)
    // `sql_name` is the engine's physical table name; persisted as "" (the
    // engine derives the real name) — confirmed against live `mvp_dbo`.
    sql_name: "",
    use_xdo: def.useXdo ?? false,
    market_item: { id: 0, version: 0, guid: "" },
  };
}

export const tableKind: ObjectKind<TableDef, TableXdo> = {
  name: "table",
  payloadKey: "dbo",
  encode: encodeTable,
};
registerKind(tableKind);

/**
 * Author a database table. When the schema is a {@link FieldMap}
 * (`{ name: f.text(), … }`), the returned handle captures its column names in
 * the {@link TableDef} `Cols` type param, so db statements that take the table
 * can type their column-name fields (`fieldName`, `output`, `sortBy`, `row`
 * keys) against the real columns. A raw `ColumnDef[]` schema stays loose.
 */
export function table<
  S extends FieldMap,
  IdT extends "int" | "uuid" = "int",
  Sys extends boolean = true,
>(
  def: Omit<TableDef, "schema" | "idType" | "system" | "seed"> & {
    schema: S;
    idType?: IdT;
    system?: Sys;
    /** Seed rows typed against this table's row shape (system columns optional). */
    seed?: SeedSource<SeedRowOf<S, IdT, Sys>>;
  },
): TableDef<SchemaCols<S>, RowOf<S, IdT, Sys>>;
/**
 * Raw-schema escape hatch: a table authored with a `ColumnDef[]` schema (no field
 * brands, so nothing to infer) stays loosely typed.
 *
 * This overload is deliberately narrowed to `ColumnDef[]` rather than accepting
 * any `TableDef`. A `FieldMap` schema would match a `TableDef`-wide signature
 * too, and TypeScript's overload resolution silently falls through to a later
 * candidate whenever the generic one does not resolve on the first pass — which
 * a function-form `seed` triggers. The result was a table whose `Cols` and `Row`
 * both collapsed with no error reported at the `table()` call (issue #164). With
 * this overload unable to match a `FieldMap`, the generic signature is the only
 * candidate and resolves, or reports a real error.
 */
export function table(def: Omit<TableDef, "schema"> & { schema: ColumnDef[] }): TableDef;
export function table(def: TableDef): TableDef {
  return def;
}
