/**
 * Hand-authored database statements (U10) — the `!map:dbo` family: read/delete/
 * exists/patch/truncate/schema against a table. Codegen defers these because the
 * target table is a `!map:dbo context.dbo.id` reference; with the guid
 * foundation (refs/guid.ts) the table resolves to its deterministic guid.
 *
 * All six share one rich envelope (engine-class metadata, not in the transform
 * schema — confirmed by the transform-temp fixtures): `description:""`,
 * `settings_registry:[]`, an `output` block (`{customize:false,filters:[],items:[]}`
 * by default; a statement with column selection — `db.get`'s `output` arg — emits
 * `{customize:true, items:[{name,children:[]}]}` per the `schema:query-auth-me` golden),
 * `addon:[]`, an always-present `as` (""-default), and `context:{dbo:{id:guid}}`.
 * Input entries are the rich form `{name,value,tag,filters,ignore,expand,children}`.
 *
 * The row-data writes (`db.add`/`db.edit`/`db.add_or_edit`) carry the row as
 * explicit input entries — one per field, each with an optional `ignore` flag
 * (system/readonly columns like `id` are stored with `ignore:true`). Authors can
 * either list the entries exactly (`data: DbField[]`) or pass a *partial* row
 * (`row: { … }`) and let {@link expandRow} fill it against the table's declared
 * columns with type defaults + a documented `ignore` heuristic. The latter is a
 * DX convenience, not a byte-clone of the engine's editor template (see
 * {@link expandRow} for why that template isn't reproducible — it's a frontend
 * artifact, and the engine's import path accepts whatever entries it's given).
 *
 * Scope: `db.add_or_edit` (extra `context.dbo.as` + inconsistent entries),
 * `db.bulk*` (array-of-rows), `db.query` (structural !function), and
 * `db.direct_query`/external SQL/`db.transaction` are deferred.
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import { encodeStatement, registerStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { c } from "../../values/value.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import { encodeAddons } from "./addon-encode.js";
import type { AddonSpec } from "./addon-encode.js";
import { leanInput } from "../lean-input.js";
import type { LeanInput } from "../lean-input.js";
import { tableColumns } from "../../kinds/table.js";
import type { ColumnDef, TableDef, InferRow } from "../../kinds/table.js";
import { encodeSearchExpression } from "../conditional.js";
import type { Comparison } from "../conditional.js";

/**
 * The column-name type for a db op's `table` argument: a typed `table()` handle
 * narrows to its declared columns (+ system columns); a bare name or an untyped
 * ref falls back to any `string`. Drives schema-aware typing of `fieldName`,
 * `output`, `sortBy`, and `row` keys.
 */
type ColsOf<T> = T extends TableDef<infer C> ? C : string;

/**
 * The single-row shape a db read yields, for `InferResponse`'s trace (U5): the
 * table's {@link InferRow}, narrowed to the selected `Cols` when an `output`
 * list is given, else the full row. A bare-name / raw-`ColumnDef[]` table has no
 * field brands, so `InferRow` is `never` → `unknown` (nothing to infer).
 */
type RowShapeOf<T extends ObjectRef, Cols extends readonly string[]> = [
  InferRow<T>,
] extends [never]
  ? unknown
  : Cols["length"] extends 0
    ? InferRow<T>
    : Pick<InferRow<T>, Extract<Cols[number], keyof InferRow<T>>>;

/**
 * The full-row shape a single-record write binds — `db.add` (inserted row),
 * `db.edit` (post-mutation row), `db.patch`/`db.add_or_edit` (upserted row).
 * Always the whole {@link InferRow} (these ops don't take a column selection), or
 * `unknown` for an unbranded bare-name table. Expressed via {@link RowShapeOf}
 * with an empty `Cols` so the `never`→`unknown` guard is shared with the reads.
 * (`db.del` is deliberately *not* here — it binds `null`; see {@link dbDel}.)
 */
type FullRowShapeOf<T extends ObjectRef> = RowShapeOf<T, readonly []>;

/**
 * A db read statement branded — **at the type level only** — via the shared
 * {@link AsShapeBrand} contract (the stack variable it binds + the shape it
 * produces). The runtime statement is a plain {@link Statement}, so
 * `encodeStatement` is unchanged.
 */
export type DbResult<As extends string, Shape> = Statement & AsShapeBrand<As, Shape>;

/** A stored rich input entry (db ops carry the expanded `{ignore,expand,children}` form). */
interface RichInput {
  name: string;
  value: string;
  tag: string;
  filters: unknown[];
  ignore: boolean;
  expand: boolean;
  children: unknown[];
}

function entry(name: string, v: Value, ignore = false): RichInput {
  return { name, value: v.value, tag: v.tag, filters: v.filters, ignore, expand: false, children: [] };
}

/**
 * Optional envelope extras for a db op: `output` restricts the returned columns;
 * `addon` attaches addons. Both default to absent (full record, empty `addon:[]`).
 * Grouped into one options bag so a statement that wants only `addon` needn't
 * thread a positional `undefined` past `output`.
 */
interface EnvelopeOpts {
  output?: readonly string[];
  addon?: readonly AddonSpec[];
}

/**
 * The shared db-op envelope fields (everything except name/context/as/input).
 * `output` switches the output block to the engine's customized form —
 * `{customize:true, items:[{name,children:[]}]}` (byte shape per the
 * `schema:query-auth-me` golden); omitted, it stays the full-record default.
 */
function envelope(
  opts: EnvelopeOpts = {},
): Pick<Statement, "description" | "settings_registry" | "output" | "addon"> {
  const { output: outputCols, addon: addons } = opts;
  return {
    description: "",
    settings_registry: [],
    // An empty selection normalizes to the full-record default — `[]` must not
    // emit the degenerate `{customize:true, items:[]}` shape no golden attests.
    output: outputCols?.length
      ? { customize: true, filters: [], items: outputCols.map((name) => ({ name, children: [] })) }
      : { customize: false, filters: [], items: [] },
    // `encodeAddons` returns `[]` when omitted, preserving the empty-`addon:[]`
    // default byte-for-byte for statements that attach none.
    addon: encodeAddons(addons),
  };
}

/** Assemble a `!map:dbo` statement: table ref → `context.dbo.id` guid + rich envelope. */
function dboStatement(
  name: string,
  table: ObjectRef,
  as: string | undefined,
  input: RichInput[],
  opts: EnvelopeOpts = {},
): Statement {
  return {
    name,
    context: { dbo: { id: resolveRef("dbo", table) } },
    as: as ?? "",
    input,
    ...envelope(opts),
  };
}

export interface DbGetArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly ColsOf<T>[] = readonly ColsOf<T>[],
> {
  /** The target table (def handle or name). */
  table: T;
  /** The lookup field (defaults to the primary key `id`). */
  fieldName?: ColsOf<T>;
  /** The value to match. */
  fieldValue: Value;
  /** Acquire a row lock for the transaction. */
  lock?: boolean;
  /**
   * Restrict the returned columns (XanoScript `output = [...]`). Encoded into
   * the customized output envelope — `{customize:true, items:[{name,children:[]}]}`
   * (byte shape per the `schema:query-auth-me` engine golden). Omitting it
   * returns the full record (`customize:false`). Note: an explicit `output`
   * list overrides column visibility — listing an `internal` column (e.g. a
   * password hash) pulls it into the statement result. Captured literally so
   * `InferResponse` narrows a traced row to exactly these columns.
   */
  output?: Cols;
  /** Attach addons to enrich each returned row (see {@link AddonSpec}). Note:
   * addon-added fields are not merged into the `InferResponse` row shape yet. */
  addon?: AddonSpec[];
  /** Capture the row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.get <table>` — fetch a single record by a field match (`mvp:dbo_getby`).
 * Returns a {@link DbResult} branded with `as` + the (optionally narrowed) row
 * shape so `InferResponse` can type a response that returns this variable. */
export function dbGet<
  T extends ObjectRef,
  const As extends string = "",
  const Cols extends readonly ColsOf<T>[] = readonly [],
>(args: DbGetArgs<T, As, Cols>): DbResult<As, RowShapeOf<T, Cols>> {
  return dboStatement(
    "mvp:dbo_getby",
    args.table,
    args.as,
    [
      entry("field_name", c.text(args.fieldName ?? "id")),
      entry("field_value", args.fieldValue),
      entry("lock", c.bool(args.lock ?? false)),
    ],
    { output: args.output, addon: args.addon },
  ) as DbResult<As, RowShapeOf<T, Cols>>;
}

export interface DbDelArgs<T extends ObjectRef = ObjectRef> {
  table: T;
  fieldName?: ColsOf<T>;
  fieldValue: Value;
  as?: string;
}

/**
 * `db.del <table>` — delete a single record by a field match (`mvp:dbo_delby`);
 * throws `NotFound`/404 when nothing matches.
 *
 * Left **unbranded** (plain {@link Statement}), unlike the other single-record
 * writes: `dbo_delby` declares an empty `getOutputSchema` and its `process()`
 * returns nothing after `$inst->delete()`, so the bound `as` variable holds
 * **`null`**, not the deleted row. `InferResponse` therefore resolves a returned
 * del var to `unknown` — matching where the engine's own OpenAPI walk falls back
 * to `json`. (Contrast `db.add`/`edit`/`patch`/`add_or_edit`, which each
 * `return $inst->toArray()` and so bind the full row.)
 */
export function dbDel<T extends ObjectRef>(args: DbDelArgs<T>): Statement {
  return dboStatement("mvp:dbo_delby", args.table, args.as, [
    entry("field_name", c.text(args.fieldName ?? "id")),
    entry("field_value", args.fieldValue),
  ]);
}

export interface DbHasArgs<T extends ObjectRef = ObjectRef, As extends string = string> {
  table: T;
  fieldName?: ColsOf<T>;
  fieldValue: Value;
  /** Capture the existence boolean into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.has <table>` — test whether a record exists by a field match (`mvp:dbo_hasby`).
 * Binds a **boolean** (the engine's `__self: bool` output), so it's branded with
 * `as` + `boolean` for `InferResponse` — table-independent, unlike the row ops. */
export function dbHas<T extends ObjectRef, const As extends string = "">(
  args: DbHasArgs<T, As>,
): DbResult<As, boolean> {
  return dboStatement("mvp:dbo_hasby", args.table, args.as, [
    entry("field_name", c.text(args.fieldName ?? "id")),
    entry("field_value", args.fieldValue),
  ]) as DbResult<As, boolean>;
}

export interface DbPatchArgs<T extends ObjectRef = ObjectRef, As extends string = string> {
  table: T;
  fieldName?: ColsOf<T>;
  fieldValue: Value;
  /** The partial row to merge (an object value). */
  data: Value;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). */
  addon?: AddonSpec[];
  /** Capture the post-patch row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.patch <table>` — partial-update a record by a field match (`mvp:dbo_patch`).
 * Binds the **full post-patch row** (`$updatedInst`), so it's branded with `as` +
 * the row shape for `InferResponse` (throws `NotFound`/404 when nothing matches). */
export function dbPatch<T extends ObjectRef, const As extends string = "">(
  args: DbPatchArgs<T, As>,
): DbResult<As, FullRowShapeOf<T>> {
  return dboStatement(
    "mvp:dbo_patch",
    args.table,
    args.as,
    [
      entry("field_name", c.text(args.fieldName ?? "id")),
      entry("field_value", args.fieldValue),
      entry("item", args.data),
    ],
    { addon: args.addon },
  ) as DbResult<As, FullRowShapeOf<T>>;
}

export interface DbTruncateArgs {
  table: ObjectRef;
  /** Reset auto-increment counters. */
  reset?: boolean;
  as?: string;
}

/** `db.truncate <table>` — empty a table (`mvp:dbo_truncate`). */
export function dbTruncate(args: DbTruncateArgs): Statement {
  return dboStatement("mvp:dbo_truncate", args.table, args.as, [
    entry("reset", c.bool(args.reset ?? false)),
  ]);
}

/** One field of a row write: a column name, its value, and whether to skip it. */
export interface DbField {
  name: string;
  value: Value;
  /** Store with `ignore:true` (system/readonly column not written), e.g. `id`. */
  ignore?: boolean;
}

function rowEntries(data: DbField[]): RichInput[] {
  return data.map((f) => entry(f.name, f.value, f.ignore ?? false));
}

/**
 * A row cell: any authored {@link Value} **except** a `col()` reference. A `col()`
 * (bare or wrapped in `withFilters`) does not resolve to the row's stored value
 * inside a `db.edit`/`db.add` `row` — it evaluates to `null` at runtime and a
 * following `fl.add(1)` aborts the engine (issue #32). The `__col?: never` bound
 * turns that live-only failure into a compile error; read the row first and pipe
 * `ref("...")` through the filter instead.
 */
export type RowCell = Value & { readonly __col?: never };

/**
 * A partial row keyed by column name — the values to write. Unspecified columns
 * get a type default on `db.add`; on `db.edit` they are marked `ignore:true` and
 * keep their stored value instead (issue #33 — see `expandRow`).
 */
export type RowMap<C extends string = string> = Partial<Record<C, RowCell>>;

/**
 * Schema-driven row expansion (DX convenience — *reachable, not byte-verified*).
 *
 * Authoring `data: DbField[]` gives exact control over every entry; passing
 * `row: { … }` instead lets sidestep expand a *partial* row against the table's
 * own declared columns: it emits one entry per column (in schema order), using
 * the author's value where given and, for unmentioned columns, a documented type
 * default on `add` — or `ignore:true` on `edit` (preserving the stored value; see
 * the `ignore` heuristic below).
 *
 * This is **not** a byte-for-byte clone of the engine's editor template. That
 * template (column ordering, the injected `@meta` system column, and the per-op
 * `ignore` flags) is produced by the frontend, not by any engine rule, and the
 * persisted goldens disagree on it — so we don't chase it. The engine's import
 * path accepts whatever `input[]` entries it's given, so this expansion is
 * correct-by-construction for import; it just won't equal a captured UI fixture.
 *
 * Defaults: the column's declared `default` (as a const) if non-empty, else
 * `[]` for list/array columns, `{}` for `obj`/`json`, else `null`. The `ignore`
 * heuristic marks the primary-key `id` (always) and, on edit, `created_at` —
 * the read-only/system columns the engine never writes. On **edit**, a column
 * the author did not mention is *also* marked `ignore:true`: a partial edit
 * touches only the keys supplied, so an unmentioned column keeps its stored
 * value instead of being overwritten with a type default (issue #33). On
 * **add** there is no stored value to preserve, so unmentioned columns still
 * emit their type default (`ignore:false`) to fill the new row.
 *
 * @TODO(verify): the type-default table and the `ignore` heuristic are DX guesses
 *   (no engine rule produces them). Confirm during the debug loop that a real Xano
 *   import accepts these expanded rows; the explicit `data: DbField[]` path is the
 *   safe escape hatch if expansion proves lossy.
 */
const SYSTEM_IGNORE: Record<"add" | "edit", ReadonlySet<string>> = {
  add: new Set(["id"]),
  edit: new Set(["id", "created_at"]),
};

function defaultCell(col: ColumnDef): Value {
  if (col.default !== undefined && col.default !== "") return c.text(String(col.default));
  if (col.array || col.style?.type === "list") return c.array([]);
  if (col.type === "obj" || col.type === "json") return c.obj({});
  return c.null();
}

/** Resolve the table's column list, requiring the full table def (a bare name carries no schema). */
function columnsOf(table: ObjectRef): ColumnDef[] {
  if (typeof table === "object" && "schema" in table && (table as TableDef).schema) {
    return tableColumns(table as TableDef);
  }
  throw new Error(
    "db row expansion needs the table definition (with a schema). Pass the table object, " +
      "or author the row explicitly via `data: [...]`.",
  );
}

function expandRow(table: ObjectRef, row: RowMap, op: "add" | "edit"): DbField[] {
  const cols = columnsOf(table);
  const colNames = new Set(cols.map((col) => col.name));
  for (const key of Object.keys(row)) {
    if (!colNames.has(key)) {
      const name = typeof table === "string" ? table : table.name;
      throw new Error(`db row: "${key}" is not a column of table "${name}".`);
    }
  }
  const systemIgnore = SYSTEM_IGNORE[op];
  return cols.map((col) => {
    const supplied = row[col.name] !== undefined;
    // On edit, a column the author didn't mention must be left untouched
    // (`ignore:true`) — otherwise the partial edit overwrites it with a type
    // default, wiping the stored value (issue #33). On add there is nothing to
    // preserve, so unmentioned columns still emit their type default.
    const ignore = systemIgnore.has(col.name) || (op === "edit" && !supplied);
    return {
      name: col.name,
      value: supplied ? row[col.name]! : defaultCell(col),
      ignore,
    };
  });
}

export interface DbAddArgs<T extends ObjectRef = ObjectRef, As extends string = string> {
  table: T;
  /** The row to insert as explicit entries (exact control over each field + `ignore`). */
  data?: DbField[];
  /** A partial row keyed by column name; expanded against the table's declared columns. */
  row?: RowMap<ColsOf<T>>;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). */
  addon?: AddonSpec[];
  /** Capture the inserted row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.add <table>` — insert a record (`mvp:dbo_add`). Binds the **full inserted
 * row** (including the auto-assigned `id`/`created_at`), so it's branded with
 * `as` + the row shape for `InferResponse`. */
export function dbAdd<T extends ObjectRef, const As extends string = "">(
  args: DbAddArgs<T, As>,
): DbResult<As, FullRowShapeOf<T>> {
  const data = args.row !== undefined ? expandRow(args.table, args.row, "add") : (args.data ?? []);
  return dboStatement(
    "mvp:dbo_add",
    args.table,
    args.as,
    rowEntries(data),
    { addon: args.addon },
  ) as DbResult<As, FullRowShapeOf<T>>;
}

export interface DbEditArgs<T extends ObjectRef = ObjectRef, As extends string = string> {
  table: T;
  fieldName?: ColsOf<T>;
  fieldValue: Value;
  /** The new field values as explicit entries (exact control over each field + `ignore`). */
  data?: DbField[];
  /**
   * A **partial** row keyed by column name: only the columns you list are
   * written. Columns you omit are emitted with `ignore:true` and keep their
   * stored value — a `{ votes }` edit updates `votes` alone and leaves every
   * other column intact (issue #33). Expanded against the table's declared
   * columns. Use `data` for byte-exact control over each entry's `ignore` flag.
   */
  row?: RowMap<ColsOf<T>>;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). */
  addon?: AddonSpec[];
  /** Capture the post-mutation row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.edit <table>` — update a record matched by a field (`mvp:dbo_editby`).
 * Binds the **full post-mutation row** (the freshly-written values), so it's
 * branded with `as` + the row shape for `InferResponse` (throws `NotFound`/404
 * when nothing matches). */
export function dbEdit<T extends ObjectRef, const As extends string = "">(
  args: DbEditArgs<T, As>,
): DbResult<As, FullRowShapeOf<T>> {
  const data = args.row !== undefined ? expandRow(args.table, args.row, "edit") : (args.data ?? []);
  return dboStatement(
    "mvp:dbo_editby",
    args.table,
    args.as,
    [
      entry("field_name", c.text(args.fieldName ?? "id")),
      entry("field_value", args.fieldValue),
      ...rowEntries(data),
    ],
    { addon: args.addon },
  ) as DbResult<As, FullRowShapeOf<T>>;
}

/**
 * `db.add_or_edit` (`mvp:dbo_addoreditby`) — upsert: edit the row matched by
 * `fieldName`/`fieldValue` if it exists, else insert. Its persisted fixture is a
 * *leaner* serialization generation than the `dbo_add`/`dbo_editby` family:
 *
 * - input entries are the lean `{name,value,tag,filters}` form (no
 *   `expand`/`children`), and only the row `data` entries carry an `ignore`
 *   flag — the `field_name`/`field_value` lookup pair never do;
 * - `context.dbo` additionally carries the table's `as` (its name) beside `id`;
 * - there is no rich `description`/`settings_registry`/`output`/`addon` envelope.
 *
 * Matched correct-by-construction against the golden, same posture as the rest
 * of the db family.
 */

export interface DbAddOrEditArgs<T extends ObjectRef = ObjectRef, As extends string = string> {
  table: T;
  /** The match field (defaults to the primary key `id`). */
  fieldName?: ColsOf<T>;
  /** The value to match for the edit branch. */
  fieldValue: Value;
  /** The row to upsert as explicit entries (exact control over each field + `ignore`). */
  data?: DbField[];
  /** A partial row keyed by column name; expanded against the table's declared columns. */
  row?: RowMap<ColsOf<T>>;
  /** Capture the upserted row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.add_or_edit <table>` — upsert a record by a field match (`mvp:dbo_addoreditby`).
 * Binds the **full upserted row** (`$inst->toArray()`, the edit-or-insert result),
 * so it's branded with `as` + the row shape for `InferResponse`. */
export function dbAddOrEdit<T extends ObjectRef, const As extends string = "">(
  args: DbAddOrEditArgs<T, As>,
): DbResult<As, FullRowShapeOf<T>> {
  const tableName = typeof args.table === "string" ? args.table : args.table.name;
  const data = args.row !== undefined ? expandRow(args.table, args.row, "edit") : (args.data ?? []);
  const input: Array<LeanInput & { ignore?: boolean }> = [
    leanInput("field_name", c.text(args.fieldName ?? "id")),
    leanInput("field_value", args.fieldValue),
    ...data.map((f) => ({ ignore: f.ignore ?? false, ...leanInput(f.name, f.value) })),
  ];
  return {
    name: "mvp:dbo_addoreditby",
    context: { dbo: { id: resolveRef("dbo", args.table), as: tableName } },
    as: args.as ?? "",
    input,
  } as DbResult<As, FullRowShapeOf<T>>;
}

export interface DbSchemaArgs {
  table: ObjectRef;
  /** Dot-path into the schema to read. */
  path: Value;
  as?: string;
}

/** `db.schema <table>` — read a table's schema (`mvp:dbo_get_schema`). */
export function dbSchema(args: DbSchemaArgs): Statement {
  return dboStatement("mvp:dbo_get_schema", args.table, args.as, [entry("path", args.path)]);
}

/**
 * Result shape of a raw-SQL query. The engine schema types this as open
 * `static:text` (default `"list"`); the known values are suggested while any
 * string remains accepted.
 */
export type DbResponseType = "list" | "single" | (string & {});

export interface DbDirectQueryArgs {
  /** The raw SQL to run (stored verbatim as `context.code`). */
  sql: string;
  /** Result shape: `"list"` (default) or `"single"`. */
  responseType?: DbResponseType;
  /** Positional bind arguments — each a tagged value (filters preserved). */
  args?: Value[];
  /** Capture the result into this stack variable. */
  as?: string;
}

/**
 * `db.direct_query` (`mvp:dbo_direct_query`) — execute raw SQL against the
 * workspace database. Unlike the `!map:dbo` family it references no table, so
 * `context` carries the SQL (`code`), the `response_type`, and the positional
 * `arg[]` bind values instead of a `dbo.id`. It keeps the same rich envelope.
 */
export function dbDirectQuery(args: DbDirectQueryArgs): Statement {
  return {
    name: "mvp:dbo_direct_query",
    context: {
      code: args.sql,
      response_type: args.responseType ?? "list",
      arg: (args.args ?? []).map((v) => ({ value: v.value, tag: v.tag, filters: v.filters })),
    },
    as: args.as ?? "",
    input: [],
    ...envelope(),
  };
}

// ---------------------------------------------------------------------------
// Structural specials below (no persisted fixture yet — shapes are modeled on
// the verified db family and the engine schema blocks, reachable now and to be
// byte-verified once a golden is vendored). Each keeps the rich db envelope and
// the `context.dbo.id` table reference where the engine schema implies one.
//
// @TODO(byte-verify): bulk add/patch/update are now grounded in DbBulk*::decode
//   (context.dbo.id + LEAN input[items/allow_id_field], no rich envelope). Still
//   unconfirmed without a golden: input[] entry order, and whether `as` is stored.
//   bulk.delete uses context.search (see its own @TODO — search shape unknown).
//   db.query (mvp:dbo_view) is now grounded in the cloud-client MVP schema +
//   converter (cloud-client MVP/xs/type/mvp/{Context,Search,Sort,Return,Statement}
//   + MVP::convertContextToConfig): filter → context.search {expression[]}, sort +
//   paging → context.return.list.{sort,paging}, output → statement output envelope
//   (issue #41/#34/#36). Derived-from-source, not a vendored golden — the emit-shape
//   fixtures cite those files; behavior is confirmed by the live cross-user repro.
//   The 5 external-SQL engines are still modeled. No dbo_bulk*/dbo_external_* goldens
//   exist in the corpus — capture one before trusting bytes.
// ---------------------------------------------------------------------------

export interface DbBulkAddArgs {
  table: ObjectRef;
  /** The rows to insert (an array value). */
  items: Value;
  /** Permit explicit `id` values in the rows. */
  allowIdField?: boolean;
  as?: string;
}

/**
 * Lean bulk-op envelope, modeled on `DbBulk*::decode`: `context.dbo.id` + LEAN
 * input entries (`convertFromAssignmentValue` → `{name,value,tag,filters}`), and
 * — unlike the rich `!map:dbo` family — NO rich envelope (decode never reads
 * output/addon/etc). The leaner serialization generation, same as add_or_edit.
 */
function bulkStatement(
  name: string,
  table: ObjectRef,
  as: string | undefined,
  input: LeanInput[],
): Statement {
  return { name, context: { dbo: { id: resolveRef("dbo", table) } }, as: as ?? "", input };
}

/** `db.bulk.add <table>` — insert many rows (`mvp:dbo_bulkadd`). */
export function dbBulkAdd(args: DbBulkAddArgs): Statement {
  return bulkStatement("mvp:dbo_bulkadd", args.table, args.as, [
    leanInput("allow_id_field", c.bool(args.allowIdField ?? false)),
    leanInput("items", args.items),
  ]);
}

export interface DbBulkDeleteArgs<As extends string = string> {
  table: ObjectRef;
  /** Optional filter selecting which rows to delete. */
  where?: Value;
  /** Capture the deleted-row count into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/**
 * `db.bulk.delete <table>` — delete many rows by a search (`mvp:dbo_bulkdelete`).
 * Unlike the other bulk ops, the filter rides `context.search` (`DB::fromSearch`),
 * NOT an input entry.
 *
 * @TODO(byte-verify): no golden — `context.search`'s exact clause shape (the
 *   query-builder search array) is unknown; the provided `where` value is passed
 *   through as-is and is almost certainly the wrong shape. CONFIRM before relying
 *   on it — a wrong/empty search could delete more rows than intended.
 *
 * Binds the **deleted-row count** (the engine's `__self: int` output), so it's
 * branded with `as` + `number` for `InferResponse` — table-independent.
 */
export function dbBulkDelete<const As extends string = "">(
  args: DbBulkDeleteArgs<As>,
): DbResult<As, number> {
  const context: Record<string, unknown> = { dbo: { id: resolveRef("dbo", args.table) } };
  if (args.where) context.search = args.where;
  // Double-cast is compiler-forced, not sloppiness: this literal's `context`
  // (`Record<string, unknown>` local) and `input: never[]` don't overlap
  // `DbResult` closely enough for a direct `as` (TS2352). The brand is phantom,
  // so the runtime literal is a plain `Statement` regardless.
  return { name: "mvp:dbo_bulkdelete", context, as: args.as ?? "", input: [] } as unknown as DbResult<
    As,
    number
  >;
}

export interface DbBulkWriteArgs<T extends ObjectRef = ObjectRef, As extends string = string> {
  table: T;
  /** The rows to write (an array value), each carrying its key. */
  items: Value;
  /** Capture the result into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.bulk.patch <table>` — partial-update many rows (`mvp:dbo_bulkpatch`).
 * Binds the **patched-row LIST** (the engine's `__self[]` row output), so it's
 * branded with `as` + the row-list shape for `InferResponse`. */
export function dbBulkPatch<T extends ObjectRef, const As extends string = "">(
  args: DbBulkWriteArgs<T, As>,
): DbResult<As, FullRowShapeOf<T>[]> {
  return bulkStatement("mvp:dbo_bulkpatch", args.table, args.as, [
    leanInput("items", args.items),
  ]) as DbResult<As, FullRowShapeOf<T>[]>;
}

/**
 * `db.bulk.update <table>` — replace many rows (`mvp:dbo_bulkupdate`).
 *
 * Left **unbranded** (plain {@link Statement}): the engine declares no output
 * schema for `dbo_bulkupdate`/`dbo_bulkadd` (empty `getOutputSchema`), so
 * `InferResponse` faithfully resolves a returned bulk-add/update var to `unknown`
 * — matching where the engine's own OpenAPI walk falls back to `json`. Only
 * `bulk.patch` (row list) and `bulk.delete` (count) carry a static output schema.
 */
export function dbBulkUpdate(args: DbBulkWriteArgs): Statement {
  return bulkStatement("mvp:dbo_bulkupdate", args.table, args.as, [leanInput("items", args.items)]);
}

/** Sort direction for a {@link SortDirective} — the engine's `orderBy` values. */
export type SortDir = "asc" | "desc" | "rand";

/**
 * One sort directive: order the returned rows by `sortBy`, ascending, descending,
 * or random. Applied by the engine — the directive lands in `context.return.list.sort`
 * as `{ sortBy, orderBy }`, the shape the `mvp:dbo_view` converter
 * (`MVP::convertContextToConfig`) reads. `dir` maps to the engine's `orderBy`.
 */
export interface SortDirective<C extends string = string> {
  /** The column (or dot-path) to sort by. */
  sortBy: C;
  /** Direction (`"asc"` | `"desc"` | `"rand"`); defaults to ascending. */
  dir?: SortDir;
}

/**
 * Static paging controls for `db.query`. Applied by the engine — these land in
 * `context.return.list.paging` (with `enabled:true`) and mirror the engine
 * schema's `return.list.paging` block: `page=1`, `per_page=25`, `offset=0`,
 * `totals=false`, `metadata=true`.
 *
 * Values are plain numbers, not {@link Value}s: the engine's `return.list.paging`
 * fields are typed `int`. Dynamic, input-bound paging (a `per_page` fed from a
 * request input) is a separate engine surface (`simpleExternal`/`external`) that
 * is out of scope here.
 *
 * Note `metadata:true` (the default) wraps the result in a paging envelope
 * (`{ items, curPage, nextPage, … }`) rather than returning a bare row list; pass
 * `metadata:false` to keep the bare array `db.query` otherwise types.
 */
export interface DbPaging {
  page?: number;
  per_page?: number;
  offset?: number;
  totals?: boolean;
  metadata?: boolean;
}

/**
 * A `db.query` filter. Author it as a comparison (or several, ANDed) with
 * `expr(col("status"), "=", c.text("published"))` — encoded into the engine's
 * operand-based `{expression:[…]}` search shape (the same algebra as a
 * conditional `when` / a table trigger's search). A raw `Value` stays the
 * escape hatch for a pre-built clause.
 */
export type DbWhere = Value | Comparison | Comparison[];

/** A `Comparison` (`{left, op, right}`) vs a tagged `Value` (`{value, tag, filters}`). */
function isComparison(w: DbWhere): w is Comparison {
  return typeof w === "object" && w !== null && !Array.isArray(w) && "op" in w && "left" in w;
}

/** Normalize a `DbWhere` to `Comparison[]`, or `null` for the raw-`Value` escape hatch. */
function toComparisons(w: DbWhere): Comparison[] | null {
  if (Array.isArray(w)) return w;
  if (isComparison(w)) return [w];
  return null;
}

/**
 * Encode `where` + `additionalWhere` into the single `context.search` the engine
 * reads (`mvp_search` = `{ expression: [...] }`). Comparison clauses from both
 * args concatenate into one `expression[]`, ANDed (`or:false`) — the engine has
 * exactly one `search`, so there is no separate `additional_where`. A raw `Value`
 * (escape hatch) passes through as `context.search` directly, but cannot be
 * combined with comparison clauses.
 */
function encodeSearch(where?: DbWhere, additionalWhere?: DbWhere): unknown {
  const clauses: Comparison[] = [];
  let raw: unknown;
  for (const w of [where, additionalWhere]) {
    if (!w) continue;
    const cmps = toComparisons(w);
    if (cmps) clauses.push(...cmps);
    else raw = w;
  }
  if (raw !== undefined && clauses.length) {
    throw new Error(
      "db.query: a raw Value `where` cannot be combined with `expr(...)` clauses — " +
        "use one form or the other.",
    );
  }
  if (clauses.length) return encodeSearchExpression(clauses);
  if (raw !== undefined) return raw;
  return undefined;
}

/**
 * Build `context.return` for a list query — the block the engine's converter
 * reads for sort (`return.list.sort`) and paging (`return.list.paging`, applied
 * only when `enabled:true`). `db.query` is always a list read; sort maps
 * `{ sortBy, dir }` → `{ sortBy, orderBy }`, and paging fills the engine's
 * `page=1`/`offset=0`/`per_page=25`/`metadata=true`/`totals=false` defaults.
 */
function encodeReturn(sort?: SortDirective[], paging?: DbPaging): unknown {
  const sortEls = (sort ?? []).map((s) => ({ sortBy: s.sortBy, orderBy: s.dir ?? "asc" }));
  const pagingObj = paging
    ? {
        enabled: true,
        page: paging.page ?? 1,
        offset: paging.offset ?? 0,
        per_page: paging.per_page ?? 25,
        metadata: paging.metadata ?? true,
        totals: paging.totals ?? false,
      }
    : { enabled: false, page: 1, offset: 0, per_page: 25, metadata: true, totals: false };
  return { type: "list", list: { distinct: "auto", sort: sortEls, paging: pagingObj } };
}

export interface DbQueryArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly ColsOf<T>[] = readonly ColsOf<T>[],
> {
  table: T;
  /** Primary filter — `expr(...)`, an array of `expr(...)` (ANDed), or a raw `Value`. */
  where?: DbWhere;
  /** Additional filter ANDed with `where` (same forms as `where`). */
  additionalWhere?: DbWhere;
  /** Sort directives (`[{ sortBy, dir }]`) — applied by the engine. */
  sort?: SortDirective<ColsOf<T>>[];
  /** Acquire row locks. */
  lock?: boolean;
  /** Paging controls (`page`/`per_page`/`offset`/`totals`/`metadata`) — applied by the engine. */
  paging?: DbPaging;
  /** Restrict returned columns. Captured literally so `InferResponse` narrows
   * the traced row list to exactly these columns. */
  output?: Cols;
  /** Attach addons to enrich each returned row (see {@link AddonSpec}). Note:
   * addon-added fields are not merged into the `InferResponse` row shape yet. */
  addon?: AddonSpec[];
  /** Capture the result list into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/**
 * `db.query <table>` — the query-all search builder (`mvp:dbo_view`). Emits the
 * cloud-client context the engine actually reads (`MVP::convertContextToConfig`):
 * the filter under `context.search` (`{expression:[…]}`, the same operand-based
 * shape as conditionals/trigger search), sort + paging under
 * `context.return.list`, and output-column restriction via the statement `output`
 * envelope. `where`/`sort`/`paging`/`output` are all applied by the engine.
 *
 * A comparison `where` (plus `additionalWhere`) encodes into one ANDed
 * `expression[]`; a raw `Value` is passed through as `context.search`.
 */
export function dbQuery<
  T extends ObjectRef,
  const As extends string = "",
  const Cols extends readonly ColsOf<T>[] = readonly [],
>(args: DbQueryArgs<T, As, Cols>): DbResult<As, RowShapeOf<T, Cols>[]> {
  const context: Record<string, unknown> = { dbo: { id: resolveRef("dbo", args.table) } };
  const search = encodeSearch(args.where, args.additionalWhere);
  if (search !== undefined) context.search = search;
  // Row lock rides `context.lock` as a tagged value (`{value, tag, filters}`),
  // not a bare bool — the shape `MVP::convertLockToConfig` reads.
  if (args.lock !== undefined) context.lock = c.bool(args.lock);
  context.return = encodeReturn(args.sort, args.paging);
  return {
    name: "mvp:dbo_view",
    context,
    as: args.as ?? "",
    input: [],
    ...envelope({ output: args.output, addon: args.addon }),
  } as unknown as DbResult<As, RowShapeOf<T, Cols>[]>;
}

export interface DbTransactionArgs {
  /** The statements to run atomically. */
  body: Statement[];
}

/**
 * `db.transaction { … }` — run a sub-stack in a database transaction
 * (`mvp:db_transaction`). A pure block statement: the engine schema declares
 * `args: []`, so it carries no `as` — only the `run` sub-stack. Byte-verified
 * (parser-minimal) against `db_transaction.json`.
 */
export function dbTransaction(args: DbTransactionArgs): Statement {
  return {
    name: "mvp:db_transaction",
    context: { run: args.body.map(encodeStatement) },
    input: [],
  };
}

/** Supported external-SQL engines for `db.external.<engine>.direct_query`. */
export type ExternalSqlEngine = "mssql" | "mysql" | "oracle" | "postgres" | "snowflake";

const EXTERNAL_SQL_NAME: Record<ExternalSqlEngine, string> = {
  mssql: "mvp:dbo_external_mssql_query",
  mysql: "mvp:dbo_external_mysql_query",
  oracle: "mvp:dbo_external_oracle_query",
  postgres: "mvp:dbo_external_postgres_query",
  snowflake: "mvp:dbo_external_snowflake_query",
};

export interface DbExternalQueryArgs {
  /** Which external database engine to target. */
  engine: ExternalSqlEngine;
  sql: string;
  /** Connection string (a value, may reference an env var). */
  connectionString: Value;
  responseType?: DbResponseType;
  args?: Value[];
  as?: string;
}

/**
 * `db.external.<engine>.direct_query` — raw SQL against an external database.
 * Stored shape from `DirectQuery::decode` (the shared base; these engines extend
 * it with `connection_string:true`): `context.{code, response_type,
 * connection_string_flex, arg[]}`. The connection string lands under
 * `connection_string_flex` (a tagged assignment value), NOT `connection_string`.
 *
 * @TODO(byte-verify): no golden. `context.parser` ("prepared" default) is a valid
 *   stored key the engine reads but is NOT emitted here (matching the internal
 *   dbo_direct_query posture); confirm it's omittable. The rich envelope is kept by
 *   analogy to the (golden-verified) internal direct_query — unconfirmed for external.
 */
export function dbExternalQuery(args: DbExternalQueryArgs): Statement {
  return {
    name: EXTERNAL_SQL_NAME[args.engine],
    context: {
      code: args.sql,
      response_type: args.responseType ?? "list",
      connection_string_flex: {
        value: args.connectionString.value,
        tag: args.connectionString.tag,
        filters: args.connectionString.filters,
      },
      arg: (args.args ?? []).map((v) => ({ value: v.value, tag: v.tag, filters: v.filters })),
    },
    as: args.as ?? "",
    input: [],
    ...envelope(),
  };
}

registerStatement("mvp:dbo_add", dbAdd);
registerStatement("mvp:dbo_editby", dbEdit);
registerStatement("mvp:dbo_addoreditby", dbAddOrEdit);
registerStatement("mvp:dbo_bulkadd", dbBulkAdd);
registerStatement("mvp:dbo_bulkdelete", dbBulkDelete);
registerStatement("mvp:dbo_bulkpatch", dbBulkPatch);
registerStatement("mvp:dbo_bulkupdate", dbBulkUpdate);
registerStatement("mvp:dbo_view", dbQuery);
registerStatement("mvp:db_transaction", dbTransaction);
registerStatement("mvp:dbo_external_mssql_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "mssql" }));
registerStatement("mvp:dbo_external_mysql_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "mysql" }));
registerStatement("mvp:dbo_external_oracle_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "oracle" }));
registerStatement("mvp:dbo_external_postgres_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "postgres" }));
registerStatement("mvp:dbo_external_snowflake_query", (a: DbExternalQueryArgs) => dbExternalQuery({ ...a, engine: "snowflake" }));
registerStatement("mvp:dbo_getby", dbGet);
registerStatement("mvp:dbo_delby", dbDel);
registerStatement("mvp:dbo_hasby", dbHas);
registerStatement("mvp:dbo_patch", dbPatch);
registerStatement("mvp:dbo_truncate", dbTruncate);
registerStatement("mvp:dbo_get_schema", dbSchema);
registerStatement("mvp:dbo_direct_query", dbDirectQuery);
