/**
 * Table (database) kind (U6) → payload key `dbo`. Columns reuse the shared
 * field encoder (KTD-6) with the column context; indexes, views, and
 * autocomplete have their own small shapes. Validated against `cloud-client:
 * …/transform-temp/schema:table*.json` (the full rich field-type corpus).
 */
import type { FieldXdo, ExprStatement } from "../types/xdo.js";
import { encodeField, COLUMN_CONTEXT } from "../fields/field.js";
import type { FieldOptions } from "../fields/field.js";
import type { FieldMap } from "../fields/catalog.js";
import type { RowFromFieldMap, Prettify } from "../fields/value-types.js";
import { encodeComparison } from "../statements/conditional.js";
import type { Comparison } from "../statements/conditional.js";
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
 * Index kind (`dbo-index-*.yaml`): `primary`/`btree` (+`btree|unique`) on
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

/** Full-text-search index language (`dbo-index-search.yaml`). */
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
  where?: Comparison;
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
  expression: ExprStatement[];
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
    { name: "id", type: idType, required: true },
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

export function encodeTable(def: TableDef): TableXdo {
  if (!def.name) throw new Error("table: `name` is required.");
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
  def: Omit<TableDef, "schema" | "idType" | "system"> & {
    schema: S;
    idType?: IdT;
    system?: Sys;
  },
): TableDef<SchemaCols<S>, RowOf<S, IdT, Sys>>;
export function table(def: TableDef): TableDef;
export function table(def: TableDef): TableDef {
  return def;
}
