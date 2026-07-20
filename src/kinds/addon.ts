/**
 * Addon kind (U8) → payload key `addon`. A lightweight composable function
 * (input + stack) with an `output` selection block and an optional `context`
 * (e.g. a db binding). The MVP models the common shape; rich db-bound contexts
 * pass through verbatim. Validated against `cloud-client: dbo/mvp/addon.yaml`.
 *
 * `addon()` optionally accepts a typed `table` handle and an `output` column
 * list; when given, it auto-fills the `context.dbo` binding (the guid the engine
 * matches on) and brands the returned handle with the addon's **graft shape** —
 * `Pick<InferRow<table>, output>`, wrapped per {@link AddonDef.cardinality} — so
 * a `db.query`/`db.get` attaching the addon can type the grafted row field
 * instead of falling back to `unknown` (issues #62, #63).
 */
import type { StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStatement } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import type { InferRow } from "./table.js";
import type { Prettify } from "../fields/value-types.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";

/** An addon's `output` selection: a typed column-name list, or the raw customize block. */
export type AddonOutput = readonly string[] | { customize?: boolean; items?: unknown[] };

/**
 * The graft shape an attached addon lands on each row — `Pick<InferRow<Tbl>,
 * Out>`, an object for `cardinality:"single"` or an array for the default
 * `"list"`. Falls back to `unknown` when the addon carries no typed `table` +
 * `output` (a bare-name/raw-context addon the SDK can't shape). Mirrors the
 * engine's list-vs-single graft (`XS::processOptimizedAddOn`, which wraps a
 * `list` return in an array and a `single` return in a bare object).
 */
export type AddonGraft<
  Tbl,
  Out extends readonly string[],
  Card extends "single" | "list",
> = [Out] extends [readonly []]
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
 * An addon definition. Set `table` + `output` to get a typed graft on attach;
 * `cardinality:"single"` grafts a single object (Xano's Single toggle) instead
 * of the default one-element array.
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
  stack?: Statement[];
  /** Bind the addon to a table — auto-fills `context.dbo` with the table's guid. */
  table?: ObjectRef;
  /** Optional binding context (e.g. `{ dbo: { id, as } }`); passed through. An explicit `dbo`/`return` here wins over the `table`/`cardinality` auto-fill. */
  context?: Record<string, unknown>;
  /** Output selection — a column-name list (typed, drives the graft shape) or the raw `{ customize, items }` block. */
  output?: AddonOutput;
  /** Result cardinality: `"single"` grafts one object; `"list"` (default) grafts an array. Encodes `context.return.type`. */
  cardinality?: "single" | "list";
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
  run: StackItemXdo[];
}

/**
 * Build the stored `context`: start from the authored `context`, then fill the
 * `dbo` binding from `table` and the `return` block from `cardinality` — but
 * only when the author hasn't set them explicitly (explicit context wins).
 */
function buildContext(def: AddonDef): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...(def.context ?? {}) };
  if (def.table !== undefined && ctx.dbo === undefined) {
    ctx.dbo = { id: resolveRef("dbo", def.table) };
  }
  if (def.cardinality === "single" && ctx.return === undefined) {
    ctx.return = { type: "single" };
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
    run: (def.stack ?? []).map(encodeStatement),
  };
}

export const addonKind: ObjectKind<AddonDef, AddonXdo> = {
  name: "addon",
  payloadKey: "addon",
  encode: encodeAddon,
};
registerKind(addonKind);

/** The authoring args for {@link addon}, generic over the table/output/cardinality that drive the graft shape. */
interface AddonArgs<
  Tbl extends ObjectRef,
  Out extends readonly string[],
  Card extends "single" | "list",
> extends Omit<AddonDef, "table" | "output" | "cardinality" | "__graft"> {
  table?: Tbl;
  output?: Out | { customize?: boolean; items?: unknown[] };
  cardinality?: Card;
}

/**
 * Author an addon. Pass a typed `table` handle + `output` column list to get a
 * typed graft when the addon is attached to a `db.query`/`db.get`, and
 * `cardinality:"single"` for a to-one (object) graft. The returned handle is
 * registered with `.registerAddons([...])` and attached via
 * `db.query({ addon: [{ addon: handle, as, input }] })`.
 */
export function addon<
  const Out extends readonly string[] = readonly [],
  Tbl extends ObjectRef = ObjectRef,
  Card extends "single" | "list" = "list",
>(def: AddonArgs<Tbl, Out, Card>): AddonDef<AddonGraft<Tbl, Out, Card>> {
  return def as AddonDef<AddonGraft<Tbl, Out, Card>>;
}
