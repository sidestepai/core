/**
 * Statement model, base envelope encoder, and registry (U5 — the KTD-4
 * extensibility seam).
 *
 * The real stored statement shape (from the golden fixture's `run[0]`) is lean:
 * `{name, as?, context, input}`. The base encoder fills the common envelope
 * (`input: []` default) so each concrete statement factory only declares its
 * `name`, optional `as`, and `context`. The registry maps statement name →
 * factory so the eventual ~500-statement catalog plugs in here.
 */
import type { FilterXdo, StackItemXdo } from "../types/xdo.js";

/**
 * The type-level contract linking a branded db statement (the **producer** —
 * `db.get`/`db.query`/`db.add`/`db.edit`/`db.patch`/`db.add_or_edit`/`db.has`/
 * `db.bulk.patch`/`db.bulk.delete`, each returning `Statement & AsShapeBrand<…>`)
 * to `InferResponse`'s single-variable trace (the **consumer** — `TraceVar`,
 * which destructures this shape). Both `__as` (the stack variable the statement
 * binds) and `__shape` (the row shape it produces) are phantom carriers — never
 * present at runtime. Naming the contract here keeps producer and consumer
 * compiler-linked, so any further branded statement joins the trace by extending
 * this type with zero edits to the trace logic.
 */
export type AsShapeBrand<As extends string, Shape> = {
  readonly __as: As;
  readonly __shape: Shape;
};

/**
 * The two envelope members every stack item carries, whatever it does.
 *
 * They are editor affordances rather than statement arguments — `disabled` is
 * how a step is commented out (it stays in the stack; the run engine skips it),
 * and `description` is the note shown on the step. `encodeStatement` writes both
 * for every statement, so every factory accepts them: the generated ones as two
 * more optional fields on their argument object, the positional specials as a
 * trailing options argument.
 *
 * Both are elided at their defaults on both sides of a round trip, so setting one
 * to `false`/`""` is the same bytes as omitting it.
 */
export interface StatementAnnotations {
  /** Leave the step in the stack but skip it at runtime — Xano's "disable step". */
  disabled?: boolean;
  /** Free-text note on the step, shown in the editor beside it. */
  description?: string;
}

/**
 * {@link StatementAnnotations} plus the result-filter option, for the statements
 * that bind an `as` variable.
 *
 * Split from the annotations rather than folded into them so `asFilters` is only
 * offered where there is a binding to attach it to: a statement that returns
 * nothing (`precondition`, `switch`, `while`, …) should not surface the option
 * in autocomplete at all. The runtime guard in {@link assertBindsAs} still
 * backs this up for callers that reach past the types.
 */
export interface StatementOptions extends StatementAnnotations {
  /**
   * Filters piped onto the result before it is bound — the editor's
   * `return as token | upper`.
   *
   * Authored from the same `fl.*` catalog as value filters and applied in
   * order, so `asFilters: [fl.trim(), fl.upper()]` trims and then upper-cases.
   *
   * The bound variable is RETYPED by the chain: `InferResponse` folds each
   * filter's declared result, so a `db.query` bound through `[fl.count()]` is a
   * `number`. Filters the engine declares as returning `any` (`get`, `set`,
   * `json_decode`, …) fold to `unknown` — see `values/filter-result.ts`.
   */
  asFilters?: FilterXdo[];
}

/**
 * Apply {@link StatementOptions} to a built statement.
 *
 * Only members that were actually authored are copied, so a factory's own
 * `description` (a few statements route one) is not clobbered by an absent key.
 *
 * `asFilters` merges into the `output` envelope rather than replacing it: a db
 * statement's column selection (`output.items`) and its result filters live in
 * the same block, and dropping one to write the other would silently discard
 * whichever the factory set first.
 */
export function annotate<T extends Statement>(stmt: T, a?: StatementOptions): T {
  if (a?.disabled !== undefined) stmt.disabled = a.disabled;
  if (a?.description !== undefined) stmt.description = a.description;
  if (a?.asFilters !== undefined && a.asFilters.length > 0) {
    assertBindsAs(stmt, "asFilters");
    stmt.output = { ...((stmt.output ?? {}) as Record<string, unknown>), filters: a.asFilters };
  }
  return stmt;
}

/**
 * Refuse an option that filters a result the statement never binds.
 *
 * The engine reads a statement's filter chain off the `as` argument, so without
 * a binding there is nothing for the chain to attach to — the filters would be
 * persisted and never run. Caught at author time because the failure is
 * otherwise invisible: the deploy succeeds and the filter simply does nothing.
 */
export function assertBindsAs(stmt: Statement, option: string): void {
  if (stmt.as) return;
  throw new Error(
    `"${stmt.name}" binds no \`as\` variable, so \`${option}\` has nothing to filter. ` +
      "Bind the result with `as` first, or drop the option.",
  );
}

/** What a statement factory returns before base-envelope encoding. */
export interface Statement {
  name: string;
  as?: string;
  context: unknown;
  input?: unknown[];
  /** `output` envelope. Lean (`{filters:[]}`) or rich (`{customize,filters,items}`) forms are both accepted and normalized to the full rich form. */
  output?: unknown;
  /** Statement description (defaults to `""`). */
  description?: string;
  /** Settings-registry bindings (defaults to `null`). */
  settings_registry?: unknown[] | null;
  /** Attached addons (defaults to `[]`). */
  addon?: unknown[];
  /** Async/runtime block (e.g. `mvp:call_agent`'s `{ mode }`); defaults to `null`. */
  runtime?: unknown;
  /** Mock overrides keyed by branch/test (defaults to `{}`). */
  mocks?: unknown;
  /** Whether the statement is disabled in the stack (defaults to `false`). */
  disabled?: boolean;
}

/**
 * Marker carrying an already-persisted envelope that `encodeStatement` must
 * return **verbatim**, skipping the registry check and the whole canonical
 * rebuild below. Set only by `raw()` (see `special/raw.ts`), which is reachable
 * from `@sidestep/core/codegen` and deliberately not from the `s` namespace.
 *
 * `Symbol.for` rather than a fresh `Symbol` so a decode tree compiled against a
 * duplicate copy of the package still short-circuits.
 */
export const RAW_ENVELOPE: unique symbol = Symbol.for("sidestep.statement.rawEnvelope") as never;

/** Registry of known statement names → factory (for catalog extensibility). */
const registry = new Map<string, (...args: any[]) => Statement>();

/** Register a statement factory under its stored `name` (e.g. `mvp:set_var`). */
export function registerStatement(
  name: string,
  factory: (...args: any[]) => Statement,
): void {
  registry.set(name, factory);
}

/** True when a statement name has a registered factory. */
export function isRegisteredStatement(name: string): boolean {
  return registry.has(name);
}

/** Look up a registered factory, throwing a clear error when absent. */
export function getStatementFactory(name: string): (...args: any[]) => Statement {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown statement "${name}". Registered: ${[...registry.keys()].join(", ") || "(none)"}`,
    );
  }
  return factory;
}

/**
 * Normalize a statement `input[]` entry to the full stored binding shape. The
 * persisted form is uniform across every statement type — `{name, value, tag,
 * filters, ignore, expand, children}` — so any missing members are filled with
 * their defaults (confirmed against live `mvp_query`/`mvp_tool`: 100% of entries
 * carry all seven keys).
 */
function fullInputEntry(raw: unknown): Record<string, unknown> {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    name: e.name,
    value: e.value,
    tag: e.tag,
    filters: e.filters ?? [],
    ignore: e.ignore ?? false,
    expand: e.expand ?? false,
    children: e.children ?? [],
  };
}

/**
 * Encode a statement into the stored `StackItemXdo`, filling the **full**
 * persisted envelope. Every stored statement carries the same 12 keys
 * regardless of type (confirmed against live `mvp_query`/`mvp_tool`), so the
 * envelope is uniform here rather than per-statement: empty members are emitted
 * with their canonical defaults so the output is 1:1 with the engine's
 * persisted form. `_xsid` is engine-generated on import; we emit `""` (the
 * stored placeholder) so the key is present for comparison.
 */
export function encodeStatement(stmt: Statement): StackItemXdo {
  // `raw()` short-circuit: the envelope is already persisted, so returning it
  // untouched is the whole point — the rebuild below would drop any key outside
  // the canonical shape, which is exactly what raw() exists to preserve.
  const rawEnvelope = (stmt as Partial<Record<typeof RAW_ENVELOPE, StackItemXdo>>)[RAW_ENVELOPE];
  if (rawEnvelope !== undefined) return rawEnvelope;

  if (!isRegisteredStatement(stmt.name)) {
    throw new Error(
      `Cannot encode unregistered statement "${stmt.name}". ` +
        `Registered: ${[...registry.keys()].join(", ") || "(none)"}`,
    );
  }
  // `output` is always the rich `{items, filters, customize}` form in the
  // persisted corpus; merge any authored output (lean or rich) over the default.
  const output = {
    items: [],
    filters: [],
    customize: false,
    ...((stmt.output ?? {}) as Record<string, unknown>),
  };
  // The persisted form stores an empty settings-registry as `null` (not `[]`);
  // the older parser fixtures emit `[]`. Canonicalize empty → null so the raw
  // output matches the engine; a populated binding list is kept verbatim.
  const sr = stmt.settings_registry;
  const settings_registry = sr == null || (Array.isArray(sr) && sr.length === 0) ? null : sr;
  return {
    as: stmt.as ?? "",
    name: stmt.name,
    _xsid: "",
    addon: stmt.addon ?? [],
    input: (stmt.input ?? []).map(fullInputEntry),
    mocks: stmt.mocks ?? {},
    output,
    context: stmt.context,
    runtime: stmt.runtime ?? null,
    disabled: stmt.disabled ?? false,
    description: stmt.description ?? "",
    settings_registry,
  };
}
