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
import type { AddonDef } from "../../kinds/addon.js";
import { leanInput } from "../lean-input.js";
import type { LeanInput } from "../lean-input.js";
import { tableColumns } from "../../kinds/table.js";
import type { ColumnDef, TableDef, InferRow } from "../../kinds/table.js";
import type { Prettify } from "../../fields/value-types.js";
import { encodeSearch, encodeSort, encodeEval } from "./db-search.js";
import type { DbWhere, SortDirective, DbEval, EvalFields, AggregateRow } from "./db-search.js";
export type { DbWhere, SortDir, SortDirective, DbEval, DbEvalFilter } from "./db-search.js";

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
 * The alias segment of a dotted addon `as` — the part after the last dot
 * (`"items._book"` → `"_book"`, `"_book"` → `"_book"`). This is the key the addon
 * grafts onto the row.
 */
type AddonAlias<S extends string> = S extends `${string}.${infer Rest}`
  ? AddonAlias<Rest>
  : S;

/** True only for `unknown` (not `any`, not a concrete type) — guards the graft narrowing below. */
type IsUnknown<T> = 0 extends 1 & T ? false : unknown extends T ? true : false;

/**
 * Narrow a graft `G` to the attachment's `output` column whitelist `O`. The
 * runtime intersects the def's selected columns with the attachment whitelist
 * (`whitelistOutput`), so the type picks `O ∩ keyof G`. Applied to the element
 * of a list graft (`Shape[]`) or a single graft (`Shape`). An `unknown` graft
 * (bare-name reference, or a def with no typed `output`) stays `unknown` — never
 * collapse it to `{}`.
 */
type NarrowGraft<G, O extends readonly string[]> = IsUnknown<G> extends true
  ? unknown
  : G extends readonly (infer E)[]
    ? Prettify<Pick<E, Extract<O[number], keyof E>>>[]
    : G extends object
      ? Prettify<Pick<G, Extract<O[number], keyof G>>>
      : G;

/**
 * The graft shape one attached addon lands on the row. A typed
 * {@link AddonDef} handle carries its shape (`Pick<row, output>`, an object or
 * array per its cardinality); a bare name/`ObjectRef` reference carries none, so
 * it grafts `unknown` — the honest floor (narrow it at the call site). An
 * attachment-level `output` further restricts the graft to those columns
 * ({@link NarrowGraft}).
 */
type GraftOf<H> = H extends { addon: AddonDef<infer G> }
  ? H extends { output: infer O extends readonly string[] }
    ? NarrowGraft<G, O>
    : G
  : unknown;

/**
 * The keys a set of attached addons graft onto each returned row. Each addon's
 * alias (the last segment of its `as`) becomes a key valued by {@link GraftOf}.
 *
 * Mirrors the engine's `applyAddOnSchema` placement — the alias always lands on
 * the *row element*. With paging the engine wraps rows under `items` (returnAs),
 * so `as:"items._book"` puts `_book` inside each `items[]` element = each row;
 * without paging `as:"_book"` puts it on each bare row. Both reduce to "the row
 * gains the alias key". Nested `children` addons enrich the addon's own result
 * (under the alias), so they add no parent-visible keys.
 */
type AddonFields<A> = A extends readonly [infer H, ...infer Rest]
  ? (H extends { as: infer S extends string } ? { [K in AddonAlias<S>]: GraftOf<H> } : object) &
      AddonFields<Rest>
  : object;

/**
 * A row shape augmented with any addon-grafted alias keys. With no addons
 * (`A = readonly []`) it is the row unchanged, so the non-addon path — and every
 * existing caller — keeps its exact shape.
 *
 * The graft **overrides** any base column of the same name rather than
 * intersecting with it (`Omit<Row, alias> & AddonFields`): the engine overwrites
 * the field with the addon result at runtime, so when an alias shadows an
 * existing column the honest type is the graft (`unknown`), not the base column.
 * An intersection would collapse `unknown & string` back to the base column and
 * silently desync the type from runtime (issue #61).
 */
type WithAddons<Row, A> = [keyof AddonFields<A>] extends [never]
  ? Row
  : Prettify<Omit<Row, keyof AddonFields<A>> & AddonFields<A>>;

/**
 * A row shape augmented with any `eval` alias keys. With no evals it is the row
 * unchanged. Like {@link WithAddons}, an eval alias **overrides** a base column of
 * the same name (the engine computes over it), so the honest type is the graft.
 */
type WithEval<Row, E> = [keyof EvalFields<E>] extends [never]
  ? Row
  : Prettify<Omit<Row, keyof EvalFields<E>> & EvalFields<E>>;

/**
 * The paging metadata envelope a `db.query` returns when `paging` is set with
 * metadata on — the engine's `packageListMeta` shape (issue #58). The result
 * list lives under `items`; `totals:true` adds `itemsTotal`/`pageTotal`. A query
 * with no `paging`, or `paging:{ metadata:false }`, returns the bare list instead.
 *
 * **Has-next signal (issue #66 bonus):** read `nextPage` — it is `number` when
 * another page exists and `null` on the last page (the engine fetches one extra
 * row to decide, so this needs no second scan). For a total count, set
 * `paging:{ totals:true }` and read `itemsTotal`/`pageTotal`. Both are typed on
 * this envelope by `InferResponse`, so a client can drive "load more" straight
 * off the typed response without hand-declaring the shape.
 */
type PagingEnvelope<Items, Totals extends boolean> = Prettify<
  {
    items: Items;
    itemsReceived: number;
    curPage: number;
    nextPage: number | null;
    prevPage: number | null;
    offset: number;
    perPage: number;
  } & (Totals extends true ? { itemsTotal: number; pageTotal: number } : object)
>;

/**
 * Whether a `paging` arg carries a page/per_page/offset field (static or a
 * `Value`) — the runtime gate that activates pagination. A `search`/`sort`-only
 * `paging` has no such field, so it does not produce the envelope.
 */
type HasPageFieldT<P> = P extends { page: unknown }
  ? true
  : P extends { per_page: unknown }
    ? true
    : P extends { offset: unknown }
      ? true
      : false;

/**
 * Whether a `paging` arg produces the metadata envelope: it activates pagination
 * (a page/per_page/offset field is present) and is not explicitly `metadata:false`
 * (the engine default is `metadata:true`).
 */
type HasPagingEnvelope<P> = P extends undefined
  ? false
  : P extends { metadata: false }
    ? false
    : HasPageFieldT<P> extends true
      ? true
      : false;

/** The `totals` flag of a `paging` arg — literal `true` only when set explicitly. */
type PagingTotals<P> = P extends { totals: true } ? true : false;

/**
 * The engine's `context.return.type` for a `db.query` — the return-type
 * discriminant. `"list"` is the default (a row array or paging envelope);
 * `"single"` a first-match object; `"count"`/`"exists"` a scalar; `"stream"` a
 * (pageable) row array with no metadata envelope.
 */
export type DbReturnType = "list" | "single" | "count" | "exists" | "stream" | "aggregate";

/** Distinct-row handling (`context.return.<list|stream>.distinct`): engine default `"auto"`. */
export type DbDistinct = "auto" | "yes" | "no";

/** Aggregate paging (`context.return.aggregate.paging`) — no `offset`/`totals` (engine schema). */
export interface DbAggregatePaging {
  page?: number;
  per_page?: number;
  /** Wrap the result in the metadata envelope (engine default `true`). */
  metadata?: boolean;
}

/**
 * Aggregate/group-by config for `returnType:"aggregate"` (`context.return.aggregate`).
 * `group` are the group-by columns and `eval` the aggregator columns (each
 * `{ name, as, filters }` — an aggregator like `sum`/`count` rides `filters`).
 * Both `as` sets graft onto the aggregate row (`unknown` values).
 */
export interface DbAggregate {
  group?: DbEval[];
  eval?: DbEval[];
  sort?: SortDirective[];
  paging?: DbAggregatePaging;
}

/** A join type for a {@link DbBind} — the engine's `bind[].join`. */
export type DbJoin = "inner" | "left" | "right";

/**
 * A join (`context.bind[]`): join `table` (aliased by `as`) with `join` kind and
 * an optional `where` join condition (same search surface as the query). Joins
 * widen what `where`/`sort`/`eval` can address by dotted path (`"author.id"`);
 * they do not by themselves change the returned row shape.
 */
export interface DbBind {
  /** The table to join. */
  table: ObjectRef;
  /** SQL alias for the joined table — defaults to the table name. Two binds to the same table need distinct aliases. */
  as?: string;
  /** Join kind (default `"inner"`). */
  join?: DbJoin;
  /** Join condition — same `where`/`cmp`/`and`/`or` surface as the query. */
  where?: DbWhere;
}

/**
 * The full `db.query` result shape, discriminated by return type `RT`:
 * `count → number`, `exists → boolean`, `single → row | null`, `stream → row[]`,
 * and `list → row[]` or the {@link PagingEnvelope} when `paging` requests
 * metadata. The row is always the addon-augmented row.
 */
type QueryResult<Row, A, P, RT extends DbReturnType, E = readonly [], AG = unknown> = RT extends "count"
  ? number
  : RT extends "exists"
    ? boolean
    : RT extends "aggregate"
      ? AggregateRow<AG>[]
      : WithAddons<WithEval<Row, E>, A> extends infer R
        ? RT extends "single"
          ? R | null
          : RT extends "stream"
            ? R[]
            : HasPagingEnvelope<P> extends true
              ? PagingEnvelope<R[], PagingTotals<P>>
              : R[]
        : never;

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
  /** Paging-envelope offset (`"items[]"`) prefixed onto top-level addons when the
   * query returns a metadata paging envelope. Set only by `dbQuery`. */
  addonOffset?: string;
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
  const { output: outputCols, addon: addons, addonOffset } = opts;
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
    addon: encodeAddons(addons, addonOffset),
  };
}

/**
 * Reject an addon whose alias (the final `as` segment) shadows a column already
 * on the queried table. The engine grafts the addon result over that field at
 * runtime, so the base column silently disappears — almost always a mistake
 * (issue #61). Only top-level aliases are checked against the query's table;
 * a bare-name table (no schema) is skipped since its columns are unknown, and
 * nested `children` graft onto their own addon's shape (not this table).
 */
function assertNoAddonShadow(table: ObjectRef, addons?: readonly AddonSpec[]): void {
  if (!addons?.length) return;
  if (typeof table === "string" || !("schema" in table)) return;
  const cols = new Set(tableColumns(table as TableDef).map((col) => col.name));
  for (const spec of addons) {
    const as = spec.as;
    const dot = as.lastIndexOf(".");
    const alias = dot === -1 ? as : as.slice(dot + 1);
    if (cols.has(alias)) {
      throw new Error(
        `addon: alias "${alias}" (from as:"${as}") shadows an existing "${table.name}" column — ` +
          `the graft overwrites it at runtime and desyncs the row type. Rename the alias ` +
          `(Xano convention: a "_" prefix, e.g. as:"${dot === -1 ? "" : as.slice(0, dot + 1)}_${alias}").`,
      );
    }
  }
}

/** Assemble a `!map:dbo` statement: table ref → `context.dbo.id` guid + rich envelope. */
function dboStatement(
  name: string,
  table: ObjectRef,
  as: string | undefined,
  input: RichInput[],
  opts: EnvelopeOpts = {},
): Statement {
  assertNoAddonShadow(table, opts.addon);
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
  A extends readonly AddonSpec[] = readonly AddonSpec[],
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
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
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
  const A extends readonly AddonSpec[] = readonly [],
>(args: DbGetArgs<T, As, Cols, A>): DbResult<As, WithAddons<RowShapeOf<T, Cols>, A>> {
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
  ) as DbResult<As, WithAddons<RowShapeOf<T, Cols>, A>>;
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

export interface DbPatchArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  A extends readonly AddonSpec[] = readonly AddonSpec[],
> {
  table: T;
  fieldName?: ColsOf<T>;
  fieldValue: Value;
  /** The partial row to merge (an object value). */
  data: Value;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
  /** Capture the post-patch row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.patch <table>` — partial-update a record by a field match (`mvp:dbo_patch`).
 * Binds the **full post-patch row** (`$updatedInst`), so it's branded with `as` +
 * the row shape for `InferResponse` (throws `NotFound`/404 when nothing matches). */
export function dbPatch<
  T extends ObjectRef,
  const As extends string = "",
  const A extends readonly AddonSpec[] = readonly [],
>(args: DbPatchArgs<T, As, A>): DbResult<As, WithAddons<FullRowShapeOf<T>, A>> {
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
  ) as DbResult<As, WithAddons<FullRowShapeOf<T>, A>>;
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

export interface DbAddArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  A extends readonly AddonSpec[] = readonly AddonSpec[],
> {
  table: T;
  /** The row to insert as explicit entries (exact control over each field + `ignore`). */
  data?: DbField[];
  /** A partial row keyed by column name; expanded against the table's declared columns. */
  row?: RowMap<ColsOf<T>>;
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
  /** Capture the inserted row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.add <table>` — insert a record (`mvp:dbo_add`). Binds the **full inserted
 * row** (including the auto-assigned `id`/`created_at`), so it's branded with
 * `as` + the row shape for `InferResponse`. */
export function dbAdd<
  T extends ObjectRef,
  const As extends string = "",
  const A extends readonly AddonSpec[] = readonly [],
>(args: DbAddArgs<T, As, A>): DbResult<As, WithAddons<FullRowShapeOf<T>, A>> {
  const data = args.row !== undefined ? expandRow(args.table, args.row, "add") : (args.data ?? []);
  return dboStatement(
    "mvp:dbo_add",
    args.table,
    args.as,
    rowEntries(data),
    { addon: args.addon },
  ) as DbResult<As, WithAddons<FullRowShapeOf<T>, A>>;
}

export interface DbEditArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  A extends readonly AddonSpec[] = readonly AddonSpec[],
> {
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
  /** Attach addons to enrich the returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` — typed from the addon's graft shape when it's a typed
   * `addon({ table, output })` handle, or `unknown` for a bare-name reference. */
  addon?: A;
  /** Capture the post-mutation row into this stack variable. Captured literally so
   * `InferResponse` can trace a `ref` back to this statement. */
  as?: As;
}

/** `db.edit <table>` — update a record matched by a field (`mvp:dbo_editby`).
 * Binds the **full post-mutation row** (the freshly-written values), so it's
 * branded with `as` + the row shape for `InferResponse` (throws `NotFound`/404
 * when nothing matches). */
export function dbEdit<
  T extends ObjectRef,
  const As extends string = "",
  const A extends readonly AddonSpec[] = readonly [],
>(args: DbEditArgs<T, As, A>): DbResult<As, WithAddons<FullRowShapeOf<T>, A>> {
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
  ) as DbResult<As, WithAddons<FullRowShapeOf<T>, A>>;
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

/**
 * Paging controls for `db.query`. Static controls (`page`/`per_page`/`offset` as
 * plain numbers) land in `context.return.list.paging` (with `enabled:true`) and
 * mirror the engine schema's `return.list.paging` block: `page=1`, `per_page=25`,
 * `offset=0`, `totals=false`, `metadata=true`.
 *
 * **Input-bound (dynamic) paging (issue #66):** pass a {@link Value} (e.g.
 * `inp("page")`) for `page`/`per_page`/`offset` instead of a number and it is
 * emitted into `context.simpleExternal.<field>` as a tagged `{value,tag,filters}`
 * (byte shape from the `simpleExternal` golden — the inner key is `value`, not
 * `operand`), while the static block stays as the engine's baseline/fallback and
 * the gate (`enabled:true`). `search`/`sort` accept a {@link Value} for a
 * dynamic custom-query / sort override; the engine reads those unconditionally.
 *
 * The `enabled:true` gate is keyed on whether a **page/per_page/offset** field is
 * present (static or `Value`) — a `paging` object carrying *only* `search`/`sort`
 * leaves `enabled:false`, so a dynamic-search-only override does not silently
 * activate default pagination and truncate the result to 25 rows.
 *
 * Note `metadata:true` (the default) wraps the result in a paging envelope
 * (`{ items, curPage, nextPage, … }`) rather than returning a bare row list; pass
 * `metadata:false` to keep the bare array. The envelope only applies when a
 * page/per_page/offset field is present.
 */
export interface DbPaging {
  page?: number | Value;
  per_page?: number | Value;
  offset?: number | Value;
  totals?: boolean;
  metadata?: boolean;
  /** Dynamic custom-query override (`context.simpleExternal.search`) — a {@link Value}, ANDed onto the static `where`. */
  search?: Value;
  /** Dynamic sort override (`context.simpleExternal.sort`) — a {@link Value}; replaces the static sort at runtime. */
  sort?: Value;
}

/** A `paging` value that is a tagged {@link Value} (input-bound) vs a plain number. */
function isPagingValue(x: unknown): x is Value {
  return typeof x === "object" && x !== null && "tag" in x && "value" in x && "filters" in x;
}

/** Whether a `paging` arg carries a page/per_page/offset field (static or `Value`) — the engine's paging gate. */
function hasPageField(paging?: DbPaging): boolean {
  return (
    !!paging &&
    (paging.page !== undefined || paging.per_page !== undefined || paging.offset !== undefined)
  );
}

/**
 * The `context.simpleExternal` block for input-bound paging: one tagged
 * `{value,tag,filters}` entry per `page`/`per_page`/`offset`/`search`/`sort`
 * field authored as a {@link Value}. Numeric fields ride the static block
 * instead, so they are omitted here. Returns `undefined` when nothing is dynamic.
 */
function encodeSimpleExternal(paging?: DbPaging): Record<string, unknown> | undefined {
  if (!paging) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of ["page", "per_page", "offset", "search", "sort"] as const) {
    const v = paging[k];
    if (isPagingValue(v)) out[k] = { value: v.value, tag: v.tag, filters: v.filters };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Which parts of a classic {@link DbExternal} blob the engine is permitted to
 * honor. Each defaults to the engine's own default (search/sort/page `true`,
 * `per_page` `false`) — the shape from the `external` golden.
 */
export interface DbExternalPermissions {
  search?: boolean;
  sort?: boolean;
  page?: boolean;
  per_page?: boolean;
}

/**
 * The classic single-blob external override (`context.external`). Its resolved
 * `value` is a whole faceted-filter object (`{search, sort, page, per_page}`),
 * typically fed from one request input; `permissions` gates which of those
 * sub-keys the engine honors. Mutually exclusive with input-bound `paging`
 * fields — the engine consults `simpleExternal` only when `external` is empty.
 */
export interface DbExternal {
  /** The whole external config as one tagged {@link Value} (e.g. `inp("filters")`). */
  value: Value;
  /** Per-part gates; each defaults to the engine default. */
  permissions?: DbExternalPermissions;
}

/**
 * Encode `context.external`: the tagged value flattened (`{value,tag,filters}`)
 * with a `permissions` object filled to the engine defaults (byte shape from the
 * `external` golden — `{search:true, sort:true, page:true, per_page:false}`).
 */
function encodeExternal(ext: DbExternal): Record<string, unknown> {
  const p = ext.permissions ?? {};
  return {
    value: ext.value.value,
    tag: ext.value.tag,
    filters: ext.value.filters,
    permissions: {
      search: p.search ?? true,
      sort: p.sort ?? true,
      page: p.page ?? true,
      per_page: p.per_page ?? false,
    },
  };
}

/**
 * Reject an `eval` whose `as` alias shadows a column already on the queried table
 * — the graft would silently override the base column (same hazard as
 * {@link assertNoAddonShadow}). A bare-name table (no schema) is skipped.
 */
/**
 * Encode `context.bind[]` — one `{ dbo:{as,id}, join, search? }` per join. `as`
 * defaults to the table name; two binds resolving to the same alias throw (SQL
 * alias collision). `search` (the join condition) is omitted when there's no
 * `where`. Byte shape from the `bind` / `bind-nosearch` goldens.
 */
function encodeBind(binds?: readonly DbBind[]): unknown[] | undefined {
  if (!binds?.length) return undefined;
  const seen = new Set<string>();
  return binds.map((b) => {
    const as = b.as ?? (typeof b.table === "string" ? b.table : b.table.name);
    if (seen.has(as)) {
      throw new Error(
        `db.query bind: duplicate join alias "${as}" — two joins to the same table need ` +
          `distinct \`as\` values so their dotted-path columns don't collide.`,
      );
    }
    seen.add(as);
    const entry: Record<string, unknown> = {
      dbo: { as, id: resolveRef("dbo", b.table) },
      join: b.join ?? "inner",
    };
    const search = encodeSearch(b.where);
    if (search !== undefined) entry.search = search;
    return entry;
  });
}

function assertNoEvalShadow(table: ObjectRef, evals?: readonly DbEval[]): void {
  if (!evals?.length) return;
  if (typeof table === "string" || !("schema" in table)) return;
  const cols = new Set(tableColumns(table as TableDef).map((col) => col.name));
  for (const e of evals) {
    if (cols.has(e.as)) {
      throw new Error(
        `db.query eval: alias "${e.as}" shadows an existing "${table.name}" column — the ` +
          `computed value would overwrite it. Rename the eval alias (e.g. "${e.as}_calc").`,
      );
    }
  }
}

/**
 * Build `context.return` for a query, discriminated by `returnType`:
 * - `count`/`exists` → a bare `{ type }` (no sub-block — the scalar rides the
 *   statement `as`);
 * - `single` → `{ type:"single", single:{ sort } }` (first match, no paging);
 * - `stream` → `{ type:"stream", stream:{ sort, distinct, paging? } }` (paging is
 *   `{ page, per_page, enabled }` only — no offset/metadata/totals);
 * - `list` (default) → `{ type:"list", list:{ distinct, sort, paging } }` with the
 *   engine's `page=1`/`offset=0`/`per_page=25`/`metadata=true`/`totals=false`
 *   defaults; the metadata envelope applies only here.
 *
 * `distinct` is hardcoded `"auto"` for now (author control is a later unit).
 */
/**
 * Encode `context.return.aggregate` — `{ sort, paging?, eval, group }`. `group`
 * and `eval` reuse the {@link encodeEval} `{ as, name, filters }` shape. Aggregate
 * paging is `{ page, per_page, metadata, enabled }` — no `offset`/`totals`.
 */
function encodeAggregate(agg?: DbAggregate): unknown {
  const block: Record<string, unknown> = {
    sort: encodeSort(agg?.sort),
    eval: encodeEval(agg?.eval) ?? [],
    group: encodeEval(agg?.group) ?? [],
  };
  if (agg?.paging) {
    block.paging = {
      page: agg.paging.page ?? 1,
      per_page: agg.paging.per_page ?? 25,
      metadata: agg.paging.metadata ?? true,
      enabled: true,
    };
  }
  return { type: "aggregate", aggregate: block };
}

function encodeReturn(
  returnType: DbReturnType,
  sort?: SortDirective[],
  paging?: DbPaging,
  forceEnabled = false,
  distinct: DbDistinct = "auto",
  aggregate?: DbAggregate,
): unknown {
  const sortEls = encodeSort(sort);
  if (returnType === "aggregate") return encodeAggregate(aggregate);
  if (returnType === "count" || returnType === "exists") return { type: returnType };
  if (returnType === "single") return { type: "single", single: { sort: sortEls } };
  // `enabled:true` gates the engine's paging (+ the simpleExternal page/per_page/
  // offset overrides). Keyed on a page/per_page/offset field being present — a
  // `search`/`sort`-only `paging` must NOT flip it on (else default pagination
  // truncates the result to 25 rows). A classic `external` blob (forceEnabled)
  // also needs the gate on for its page/per_page to take effect.
  const enabled = hasPageField(paging) || forceEnabled;
  const staticInt = (v: number | Value | undefined, def: number): number =>
    typeof v === "number" ? v : def;
  if (returnType === "stream") {
    // Stream paging is `{ page, per_page, enabled }` only — no offset/metadata/totals.
    const stream: Record<string, unknown> = { sort: sortEls, distinct };
    if (enabled) {
      stream.paging = {
        page: staticInt(paging?.page, 1),
        per_page: staticInt(paging?.per_page, 25),
        enabled: true,
      };
    }
    return { type: "stream", stream };
  }
  const pagingObj = {
    enabled,
    page: staticInt(paging?.page, 1),
    offset: staticInt(paging?.offset, 0),
    per_page: staticInt(paging?.per_page, 25),
    metadata: paging?.metadata ?? true,
    totals: paging?.totals ?? false,
  };
  return { type: "list", list: { distinct, sort: sortEls, paging: pagingObj } };
}

export interface DbQueryArgs<
  T extends ObjectRef = ObjectRef,
  As extends string = string,
  Cols extends readonly ColsOf<T>[] = readonly ColsOf<T>[],
  A extends readonly AddonSpec[] = readonly AddonSpec[],
  P extends DbPaging | undefined = DbPaging | undefined,
  RT extends DbReturnType = DbReturnType,
  E extends readonly DbEval[] = readonly DbEval[],
  AG extends DbAggregate = DbAggregate,
> {
  table: T;
  /**
   * The engine's `context.return.type`. `"list"` (default) returns a row array
   * (or paging envelope); `"single"` a first-match `row | null`; `"count"` a
   * `number`; `"exists"` a `boolean`; `"stream"` a pageable `row[]` with no
   * metadata envelope. `InferResponse` reflects each shape.
   */
  returnType?: RT;
  /** Primary filter — `expr(...)`, an array of `expr(...)` (ANDed), or a raw `Value`. */
  where?: DbWhere;
  /** Additional filter ANDed with `where` (same forms as `where`). */
  additionalWhere?: DbWhere;
  /**
   * Joins (`context.bind[]`) — `[{ table, as?, join?, where? }]`. Joined columns
   * are addressable by dotted path in `where`/`sort`/`eval`; the row shape is
   * unchanged (output columns still come from `output`/`eval`).
   */
  bind?: DbBind[];
  /** Sort directives (`[{ sortBy, dir }]`) — applied by the engine. */
  sort?: SortDirective<ColsOf<T>>[];
  /** Acquire row locks. */
  lock?: boolean;
  /**
   * Paging controls (`page`/`per_page`/`offset`/`totals`/`metadata`) — applied by
   * the engine. **Supplying `paging` changes the response shape:** with metadata
   * on (the default) the result is wrapped in a paging envelope
   * (`{ items, curPage, nextPage, prevPage, offset, perPage, itemsReceived }`,
   * plus `itemsTotal`/`pageTotal` when `totals:true`) instead of a bare row list,
   * and `InferResponse` reflects that (issue #58). Pass `metadata:false` to keep
   * the bare array.
   */
  paging?: P;
  /**
   * Classic single-blob external override (`context.external`) — one tagged
   * {@link Value} whose resolved value is a whole `{search,sort,page,per_page}`
   * config, with per-part `permissions` gates. Mutually exclusive with an
   * input-bound `paging` field (a `Value` page/per_page/offset/search/sort): the
   * engine honors `simpleExternal` only when `external` is empty, so authoring
   * both throws. Setting `external` forces `paging.enabled:true` so its
   * page/per_page take effect even with no `paging` arg.
   */
  external?: DbExternal;
  /**
   * Distinct-row handling for a `list`/`stream` query (`"auto"` default | `"yes"`
   * | `"no"`) → `context.return.<type>.distinct`. Ignored for single/count/exists.
   */
  distinct?: DbDistinct;
  /**
   * Computed output columns (`context.eval[]`) — each `{ name, as, filters? }`.
   * The `as` alias grafts onto every returned row as an `unknown`-typed key
   * (`InferResponse`), since a filter pipeline's output isn't statically knowable.
   * An alias shadowing an existing column throws at build time.
   */
  eval?: E;
  /**
   * Aggregate/group-by config, used with `returnType:"aggregate"` →
   * `context.return.aggregate.{group,eval,sort,paging}`. `InferResponse` types the
   * aggregate row from the `group` and `eval` aliases (values `unknown`).
   */
  aggregate?: AG;
  /** Restrict returned columns. Captured literally so `InferResponse` narrows
   * the traced row list to exactly these columns. */
  output?: Cols;
  /** Attach addons to enrich each returned row (see {@link AddonSpec}). Each
   * addon's alias (the last segment of its `as`) is merged onto the row shape in
   * `InferResponse` as an `unknown`-typed key — narrow it at the call site. Author
   * `as` relative to a row (`"_user"`); when the query returns a metadata paging
   * envelope, the `items[]` offset is prefixed automatically. */
  addon?: A;
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
  const A extends readonly AddonSpec[] = readonly [],
  const P extends DbPaging | undefined = undefined,
  const RT extends DbReturnType = "list",
  const E extends readonly DbEval[] = readonly [],
  const AG extends DbAggregate = DbAggregate,
>(
  args: DbQueryArgs<T, As, Cols, A, P, RT, E, AG>,
): DbResult<As, QueryResult<RowShapeOf<T, Cols>, A, P, RT, E, AG>> {
  assertNoAddonShadow(args.table, args.addon);
  assertNoEvalShadow(args.table, args.eval);
  const returnType: DbReturnType = args.returnType ?? "list";
  const context: Record<string, unknown> = { dbo: { id: resolveRef("dbo", args.table) } };
  const search = encodeSearch(args.where, args.additionalWhere);
  if (search !== undefined) context.search = search;
  const binds = encodeBind(args.bind);
  if (binds) context.bind = binds;
  const evals = encodeEval(args.eval);
  if (evals) context.eval = evals;
  // Row lock rides `context.lock` as a tagged value (`{value, tag, filters}`),
  // not a bare bool — the shape `MVP::convertLockToConfig` reads.
  if (args.lock !== undefined) context.lock = c.bool(args.lock);
  // Input-bound paging (issue #66): `Value`-typed page/per_page/offset/search/sort
  // ride `context.simpleExternal` on top of the static block (which is the gate).
  const simpleExternal = encodeSimpleExternal(args.paging);
  if (args.external !== undefined) {
    // The engine consults `simpleExternal` only when `external` is empty, so
    // authoring both silently drops the per-field binds. Fail at the source.
    if (simpleExternal) {
      throw new Error(
        "db.query: `external` (classic blob) and input-bound `paging` fields (a Value " +
          "page/per_page/offset/search/sort → simpleExternal) are mutually exclusive — the " +
          "engine honors `external` and ignores simpleExternal. Use one or the other.",
      );
    }
    // `external`'s page/per_page are gated by static `paging.enabled` just like
    // simpleExternal — force it on so a self-contained blob isn't silently no-op'd.
    context.return = encodeReturn(returnType, args.sort, args.paging, true, args.distinct, args.aggregate);
    context.external = encodeExternal(args.external);
  } else {
    context.return = encodeReturn(returnType, args.sort, args.paging, false, args.distinct, args.aggregate);
    if (simpleExternal) context.simpleExternal = simpleExternal;
  }
  // A `list` query with paging enabled + metadata on returns a paging envelope,
  // so its rows live under `items[]` — top-level addons must graft there. Paging
  // is enabled by a page/per_page/offset field or a classic `external` blob; the
  // frontend's return-type editor applies the identical `items[]` prefix.
  const usesPagingEnvelope =
    returnType === "list" &&
    (hasPageField(args.paging) || args.external !== undefined) &&
    (args.paging?.metadata ?? true);
  return {
    name: "mvp:dbo_view",
    context,
    as: args.as ?? "",
    input: [],
    ...envelope({
      output: args.output,
      addon: args.addon,
      addonOffset: usesPagingEnvelope ? "items[]" : undefined,
    }),
  } as unknown as DbResult<As, QueryResult<RowShapeOf<T, Cols>, A, P, RT, E, AG>>;
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
