/**
 * Addon kind (U8) → payload key `addon`. An addon is a single table-bound db
 * query (an `input` block + an `output` selection + a `context` that carries the
 * dbo binding and `return`), *not* a statement stack — the engine runs it
 * straight off `context`. The MVP models the common shape;
 * rich db-bound contexts pass through verbatim. Validated against the Xano
 * engine's persisted addon shape (whose xdo schema has no `run`/stack).
 *
 * `addon()` optionally accepts a typed `table` handle and an `output` column
 * list; when given, it auto-fills the `context.dbo` binding (the guid the engine
 * matches on) and brands the returned handle with the addon's **graft shape** —
 * `Pick<InferRow<table>, output>`, wrapped per {@link AddonDef.cardinality} — so
 * a `db.query`/`db.get` attaching the addon can type the grafted row field
 * instead of falling back to `unknown` (issues #62, #63).
 */
import type { InputXdo } from "../types/xdo.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import { encodeSearch, encodeSort, encodeEval } from "../statements/special/db-search.js";
import type {
  DbWhere,
  SortDirective,
  DbEval,
  AggregateRow,
} from "../statements/special/db-search.js";
import type { InferRow } from "./table.js";
import type { Prettify } from "../fields/value-types.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";

/** An addon's `output` selection: a typed column-name list, or the raw customize block. */
export type AddonOutput = readonly string[] | { customize?: boolean; items?: unknown[] };

/**
 * An addon's result cardinality — the query `return.type` the engine reads to
 * shape the graft:
 *
 * - `"single"` — one object (Xano's Single toggle; `listable:false`).
 * - `"list"`   — an array (the default; absent `return` coerces to `list`).
 * - `"count"`  — an `int` count.
 * - `"exists"` — a `bool`.
 * - `"aggregate"` — a grouped aggregation; its shape depends on the `group`/`eval`
 *   config (supplied via a raw `context.return`), so the graft stays `unknown`.
 */
export type AddonCardinality = "single" | "list" | "count" | "exists" | "aggregate";

/**
 * The graft shape an attached addon lands on each row. For a table-bound addon
 * with an `output` list it's `Pick<InferRow<Tbl>, Out>`, wrapped per the
 * cardinality: an object (`"single"`) or an array (`"list"`). `"count"` grafts a
 * `number` and `"exists"` a `boolean` (the `output`/`table` are irrelevant to
 * those); `"aggregate"` grafts an array keyed by the declared `group`/`eval`
 * aliases (values `unknown`), or `unknown` when neither is declared. Falls back to
 * `unknown` when the addon carries no typed `table` + `output` (a bare-name/raw-context addon the SDK can't shape).
 * Mirrors the engine's per-return-type graft.
 */
export type AddonGraft<
  Tbl,
  Out extends readonly string[],
  Card extends AddonCardinality,
  Grp extends readonly DbEval[] = readonly [],
  Ev extends readonly DbEval[] = readonly [],
> = Card extends "count"
  ? number
  : Card extends "exists"
    ? boolean
    : Card extends "aggregate"
      ? [Grp, Ev] extends [readonly [], readonly []]
        ? unknown // no group/eval declared → honest floor
        : Prettify<AggregateRow<{ group: Grp; eval: Ev }>>[]
      : [Out] extends [readonly []]
        ? unknown
        : InferRow<Tbl> extends infer Row
          ? [Row] extends [never]
            ? unknown
            : Row extends object
              ? Card extends "single"
                ? Prettify<Pick<Row, Extract<Out[number], keyof Row>>>
                : Prettify<Pick<Row, Extract<Out[number], keyof Row>>>[]
              : unknown
          : unknown;

/**
 * An addon definition. An addon is a single table-bound db query, not a
 * statement stack — the engine executes it straight off its `context` (dbo
 * binding + `return` + search/sort/eval), which is exactly what `table`,
 * `cardinality`, and a raw `context` build here (the engine reads
 * `context`; the fetched `run: [mvp:dbo_view]` is a server-derived artifact and
 * is not part of the stored addon schema). Set `table` +
 * `output` to get a typed graft on attach; `cardinality:"single"` grafts a
 * single object (Xano's Single toggle) instead of the default array.
 *
 * @typeParam Graft - phantom carrier for the addon's graft shape, captured by
 *   {@link addon} from `table`/`output`/`cardinality`. Read by a db op's
 *   response typing. Defaults to `unknown`; never assigned at runtime.
 */
export interface AddonDef<Graft = unknown> {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  tags?: string[];
  input?: Record<string, InputDescriptor>;
  /** Bind the addon to a table — auto-fills `context.dbo` with the table's guid. */
  table?: ObjectRef;
  /** The addon's filter — the predicate binding it to the parent row, e.g. `expr(col("id"), "=", inp("user_id"))`. Same `where` surface as `s.db.query`; encodes `context.search`. */
  where?: DbWhere;
  /** Sort the returned rows (`[{ sortBy, dir }]`). Same surface as `s.db.query`; encodes `context.sort`. */
  sort?: SortDirective[];
  /** Optional binding context (e.g. `{ dbo: { id, as }, bind: […] }`); passed through. An explicit `dbo`/`search`/`sort`/`return` here wins over the `table`/`where`/`sort`/`cardinality` auto-fill. */
  context?: Record<string, unknown>;
  /** Output selection — a column-name list (typed, drives the graft shape) or the raw `{ customize, items }` block. */
  output?: AddonOutput;
  /** Result cardinality (query `return.type`): `"single"` → object, `"list"` (default) → array, `"count"` → number, `"exists"` → boolean, `"aggregate"` → grouped rows. Encodes `context.return.type` (omitted for the `"list"` default). */
  cardinality?: AddonCardinality;
  /** Aggregate group-by columns (with `cardinality:"aggregate"`) → `context.return.aggregate.group`. Each `as` grafts onto the aggregate row. */
  group?: DbEval[];
  /** Aggregate/eval columns (with `cardinality:"aggregate"`) → `context.return.aggregate.eval`. Each `as` grafts onto the aggregate row. */
  eval?: DbEval[];
  /** @internal phantom carrier for {@link Graft}; never assigned at runtime. */
  readonly __graft?: Graft;
}

export interface AddonXdo {
  name: string;
  description: string;
  context: Record<string, unknown>;
  output: { customize: boolean; items: unknown[] };
  tag: Array<{ tag: string }>;
  input: InputXdo[];
}

/**
 * Build the stored `context`: start from the authored `context`, then fill the
 * `dbo` binding from `table`, `search` from `where`, `sort` from `sort`, and the
 * `return` block from `cardinality` — but only when the author hasn't set each
 * explicitly (explicit context wins).
 */
function buildContext(def: AddonDef): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...(def.context ?? {}) };
  if (def.table !== undefined && ctx.dbo === undefined) {
    ctx.dbo = { id: resolveRef("dbo", def.table) };
  }
  if (def.where !== undefined && ctx.search === undefined) {
    const search = encodeSearch(def.where);
    if (search !== undefined) ctx.search = search;
  }
  if (def.sort !== undefined && ctx.sort === undefined) {
    const sort = encodeSort(def.sort);
    // Drop an empty/no-op sort rather than write a bare `context.sort: []`.
    if (sort.length) ctx.sort = sort;
  }
  // The graft type is derived from `cardinality`, so a raw `context.return.type`
  // that contradicts it would type one shape and encode another. A *matching*
  // type (a richer explicit `return` for the same cardinality — e.g. aggregate's
  // `group`/`eval`) is fine; a differing type is a silent desync, so throw.
  const explicitReturn = ctx.return as { type?: string } | undefined;
  if (
    def.cardinality !== undefined &&
    explicitReturn?.type !== undefined &&
    explicitReturn.type !== def.cardinality
  ) {
    throw new Error(
      `addon: cardinality:"${def.cardinality}" conflicts with an explicit ` +
        `context.return.type "${explicitReturn.type}" — they shape the graft differently. ` +
        "Set one, not both.",
    );
  }
  // `"list"` is the engine default (absent `return` coerces to list), so omit it
  // to keep the stored context lean; any other cardinality encodes `return.type`.
  if (def.cardinality !== undefined && def.cardinality !== "list" && ctx.return === undefined) {
    if (def.cardinality === "aggregate") {
      // Build the full aggregate block from group/eval (same {as,name,filters}
      // shape as db.query aggregate) so the graft type matches the emit.
      ctx.return = {
        type: "aggregate",
        aggregate: {
          sort: encodeSort(def.sort),
          eval: encodeEval(def.eval) ?? [],
          group: encodeEval(def.group) ?? [],
        },
      };
    } else {
      ctx.return = { type: def.cardinality };
    }
  }
  return ctx;
}

/**
 * Build the stored output block. A column-name list encodes to the customized
 * form (`{ customize:true, items:[{name}] }`, matching the engine's exported
 * addon output); the raw block passes through; absent → the full-record default.
 */
function buildOutput(output?: AddonOutput): { customize: boolean; items: unknown[] } {
  if (!output) return { customize: false, items: [] };
  if (Array.isArray(output)) {
    return { customize: true, items: output.map((name) => ({ name })) };
  }
  const block = output as { customize?: boolean; items?: unknown[] };
  return { customize: block.customize ?? false, items: block.items ?? [] };
}

export function encodeAddon(def: AddonDef): AddonXdo {
  if (!def.name) throw new Error("addon: `name` is required.");
  return {
    name: def.name,
    description: def.description ?? "",
    context: buildContext(def),
    output: buildOutput(def.output),
    tag: encodeTags(def.tags),
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
  };
}

export const addonKind: ObjectKind<AddonDef, AddonXdo> = {
  name: "addon",
  payloadKey: "addon",
  encode: encodeAddon,
};
registerKind(addonKind);

/** The authoring args for {@link addon}, generic over the table/output/cardinality/group/eval that drive the graft shape. */
interface AddonArgs<
  Tbl extends ObjectRef,
  Out extends readonly string[],
  Card extends AddonCardinality,
  Grp extends readonly DbEval[],
  Ev extends readonly DbEval[],
> extends Omit<AddonDef, "table" | "output" | "cardinality" | "group" | "eval" | "__graft"> {
  table?: Tbl;
  output?: Out | { customize?: boolean; items?: unknown[] };
  cardinality?: Card;
  group?: Grp;
  eval?: Ev;
}

/**
 * Author an addon. Pass a typed `table` handle + `output` column list to get a
 * typed graft when the addon is attached to a `db.query`/`db.get`, and a
 * `cardinality` to shape it: `"single"` (object), `"list"` (array, default),
 * `"count"` (number), `"exists"` (boolean), or `"aggregate"` (grouped rows). For
 * `"aggregate"`, pass `group`/`eval` (`{ name, as, filters? }`) and the graft is
 * typed from their aliases. The returned handle is registered with
 * `.registerAddons([...])` and attached via
 * `db.query({ addon: [{ addon: handle, as, input }] })`.
 */
export function addon<
  const Out extends readonly string[] = readonly [],
  Tbl extends ObjectRef = ObjectRef,
  Card extends AddonCardinality = "list",
  const Grp extends readonly DbEval[] = readonly [],
  const Ev extends readonly DbEval[] = readonly [],
>(def: AddonArgs<Tbl, Out, Card, Grp, Ev>): AddonDef<AddonGraft<Tbl, Out, Card, Grp, Ev>> {
  return def as AddonDef<AddonGraft<Tbl, Out, Card, Grp, Ev>>;
}
